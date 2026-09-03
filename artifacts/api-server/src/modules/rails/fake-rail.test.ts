import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sampleCanonical } from "../../test-helpers/canonical.ts";
import { startFakeRail, type FakeRail } from "./fake-rail.ts";

// The conformance fake rail's own contract (R95): the control surface the
// e2e harness drives over HTTP, scripted faults that expire after `times`
// calls, a wildcard for every unscripted invoice, a store that makes a
// re-sent key a REAL duplicate, and credentials enforced on both operations.

let fake: FakeRail;
const TOKEN = "fake-rail-token";

before(async () => {
  fake = await startFakeRail({ token: TOKEN });
});
after(async () => {
  await fake.close();
});

let seq = 0;
function submission() {
  seq += 1;
  const inv = sampleCanonical(`INV-FAKE-${process.pid}-${seq}`);
  return { inv, key: `${randomUUID()}:${inv.invoiceNumber}` };
}

async function post(
  body: unknown,
  headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` },
): Promise<Response> {
  return fetch(`${fake.url}/v0/submissions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function control(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${fake.url}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("healthz answers, unknown paths are 404, a submission needs a key and an invoice", async () => {
  const health = await control("GET", "/__fake/healthz");
  assert.equal(health.status, 200);
  assert.equal(((await health.json()) as { ok: boolean }).ok, true);
  assert.equal((await control("GET", "/nope")).status, 404);
  assert.equal((await control("GET", "/__fake/nope")).status, 404);
  const bad = await post({ invoice: sampleCanonical("INV-NO-KEY") });
  assert.equal(bad.status, 400);
  assert.equal(((await bad.json()) as { code: string }).code, "BAD_REQUEST");
});

test("PUT /__fake/script validates and queues; a fault expires after `times` calls", async () => {
  const unknown = await control("PUT", "/__fake/script", { invoiceNumber: "X", outcome: "explode" });
  assert.equal(unknown.status, 400);
  const missing = await control("PUT", "/__fake/script", { outcome: "accept" });
  assert.equal(missing.status, 400);

  const { inv, key } = submission();
  const queued = await control("PUT", "/__fake/script", {
    invoiceNumber: inv.invoiceNumber,
    outcome: "unavailable",
    times: 2,
  });
  assert.equal(queued.status, 204);
  const statuses: number[] = [];
  for (let i = 0; i < 3; i++) {
    const resp = await post({ idempotencyKey: `${key}-${i}`, rail: "rail_primary", invoice: inv });
    statuses.push(resp.status);
    await resp.text();
  }
  assert.deepEqual(statuses, [503, 503, 201]);
  const outcomes = fake.calls
    .filter((c) => c.invoiceNumber === inv.invoiceNumber)
    .map((c) => c.outcome);
  assert.deepEqual(outcomes, ["unavailable", "unavailable", "accept"]);
});

test("a wildcard scripts every invoice not otherwise scripted; a specific script wins", async () => {
  fake.script("*", { outcome: "reject", code: "MBS_INVALID_TIN", times: 1 });
  const specific = submission();
  fake.script(specific.inv.invoiceNumber, { outcome: "rate_limit", times: 1 });
  const s = await post({ idempotencyKey: specific.key, rail: "rail_primary", invoice: specific.inv });
  assert.equal(s.status, 429);
  assert.equal(s.headers.get("retry-after"), "1");
  await s.text();
  const any = submission();
  const a = await post({ idempotencyKey: any.key, rail: "rail_primary", invoice: any.inv });
  assert.equal(a.status, 422);
  assert.equal(((await a.json()) as { code: string }).code, "MBS_INVALID_TIN");
  const after = submission();
  const ok = await post({ idempotencyKey: after.key, rail: "rail_primary", invoice: after.inv });
  assert.equal(ok.status, 201, "the wildcard was consumed");
  await ok.text();
});

test("an accepted key is held: re-sent it is 409, looked up it is the same stamp; DELETE /__fake forgets it", async () => {
  const { inv, key } = submission();
  const first = await post({ idempotencyKey: key, rail: "rail_primary", invoice: inv });
  assert.equal(first.status, 201);
  const stamp = (await first.json()) as { irn: string; csid: string };
  assert.match(stamp.irn, /^IRN-[0-9A-F]{16}$/);
  const again = await post({ idempotencyKey: key, rail: "rail_primary", invoice: inv });
  assert.equal(again.status, 409);
  assert.equal(((await again.json()) as { code: string }).code, "MBS_DUPLICATE");
  const found = await fetch(`${fake.url}/v0/submissions/${encodeURIComponent(key)}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(found.status, 200);
  assert.deepEqual(await found.json(), fake.held.get(key));
  assert.ok(fake.calls.length > 0);

  const reset = await control("DELETE", "/__fake");
  assert.equal(reset.status, 204);
  const health = (await (await control("GET", "/__fake/healthz")).json()) as { held: number; calls: number };
  assert.equal(health.held, 0);
  assert.equal(health.calls, 0);
  const fresh = await post({ idempotencyKey: key, rail: "rail_primary", invoice: inv });
  assert.equal(fresh.status, 201, "no longer a duplicate once forgotten");
  await fresh.text();
});

test("a scripted duplicate is recoverable only with holdsStamp", async () => {
  const orphan = submission();
  await control("PUT", "/__fake/script", { invoiceNumber: orphan.inv.invoiceNumber, outcome: "duplicate" });
  const d1 = await post({ idempotencyKey: orphan.key, rail: "rail_primary", invoice: orphan.inv });
  assert.equal(d1.status, 409);
  await d1.text();
  const miss = await fetch(`${fake.url}/v0/submissions/${encodeURIComponent(orphan.key)}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(miss.status, 404);
  await miss.text();

  const held = submission();
  await control("PUT", "/__fake/script", {
    invoiceNumber: held.inv.invoiceNumber,
    outcome: "duplicate",
    holdsStamp: true,
  });
  const d2 = await post({ idempotencyKey: held.key, rail: "rail_primary", invoice: held.inv });
  assert.equal(d2.status, 409);
  await d2.text();
  const hit = await fetch(`${fake.url}/v0/submissions/${encodeURIComponent(held.key)}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(hit.status, 200);
  assert.match(((await hit.json()) as { irn: string }).irn, /^IRN-/);
});

test("credentials are enforced on submit and lookup; the calls log says so", async () => {
  const { inv, key } = submission();
  const noAuth = await post({ idempotencyKey: key, rail: "rail_primary", invoice: inv }, {});
  assert.equal(noAuth.status, 401);
  await noAuth.text();
  const wrong = await fetch(`${fake.url}/v0/submissions/${encodeURIComponent(key)}`, {
    headers: { authorization: "Bearer nope" },
  });
  assert.equal(wrong.status, 401);
  await wrong.text();
  const log = (await (await control("GET", "/__fake/calls")).json()) as Array<{ authorized: boolean; outcome: string }>;
  const last = log.slice(-2);
  assert.deepEqual(
    last.map((c) => [c.authorized, c.outcome]),
    [[false, "unauthorized"], [false, "unauthorized"]],
  );
});

test("a scripted timeout holds the response until the client gives up, and close() releases it", async () => {
  const { inv, key } = submission();
  fake.script(inv.invoiceNumber, { outcome: "timeout" });
  const controller = new AbortController();
  const attempt = fetch(`${fake.url}/v0/submissions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ idempotencyKey: key, rail: "rail_primary", invoice: inv }),
    signal: controller.signal,
  });
  const raced = await Promise.race([
    attempt.then(() => "answered"),
    new Promise<string>((resolve) => setTimeout(() => resolve("silent"), 300)),
  ]);
  assert.equal(raced, "silent");
  controller.abort();
  await attempt.catch(() => undefined);
  assert.equal(fake.calls.at(-1)?.outcome, "timeout");
});
