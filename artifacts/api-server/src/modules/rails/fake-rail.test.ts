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

async function lookup(key: string): Promise<Response> {
  return fetch(`${fake.url}/v0/submissions/${encodeURIComponent(key)}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
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

// ---- Lookup-op scripts: the GET a recovery makes can fail too ----

test("a lookup-op script faults the GET, never the POST: 503, 401, 429 and a 200 that is not a stamp", async () => {
  const cells: Array<["unavailable" | "unauthorized" | "rate_limit" | "malformed", number, string | null]> = [
    ["unavailable", 503, "RAIL_UNAVAILABLE"],
    ["unauthorized", 401, "RAIL_UNAUTHORIZED"],
    ["rate_limit", 429, "RAIL_RATE_LIMITED"],
    ["malformed", 200, null],
  ];
  for (const [outcome, status, code] of cells) {
    const { inv, key } = submission();
    fake.script(inv.invoiceNumber, { op: "lookup", outcome, times: 1 });
    const posted = await post({ idempotencyKey: key, rail: "rail_primary", invoice: inv });
    assert.equal(posted.status, 201, `${outcome}: the submit is untouched by a lookup-op script`);
    await posted.text();

    const got = await lookup(key);
    assert.equal(got.status, status, outcome);
    const body = (await got.json()) as Record<string, unknown>;
    if (code === null) {
      assert.equal(body.irn, undefined, "not the shape the profile defines");
      assert.equal(typeof body.stamp, "string");
    } else {
      assert.equal(body.code, code, outcome);
    }
    assert.equal(fake.calls.at(-1)?.outcome, `lookup_${outcome}`);
    assert.equal(fake.calls.at(-1)?.idempotencyKey, key);

    const again = await lookup(key);
    assert.equal(again.status, 200, `${outcome}: once consumed the stamp the rail holds is answered`);
    assert.deepEqual(await again.json(), fake.held.get(key));
  }
});

test("a lookup-op timeout holds the GET until the client gives up", async () => {
  const { inv, key } = submission();
  const posted = await post({ idempotencyKey: key, rail: "rail_primary", invoice: inv });
  assert.equal(posted.status, 201);
  await posted.text();
  fake.script(inv.invoiceNumber, { op: "lookup", outcome: "timeout" });
  const controller = new AbortController();
  const attempt = fetch(`${fake.url}/v0/submissions/${encodeURIComponent(key)}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
    signal: controller.signal,
  });
  const raced = await Promise.race([
    attempt.then(() => "answered"),
    new Promise<string>((resolve) => setTimeout(() => resolve("silent"), 300)),
  ]);
  assert.equal(raced, "silent");
  controller.abort();
  await attempt.catch(() => undefined);
  assert.equal(fake.calls.at(-1)?.outcome, "lookup_timeout");
  assert.equal(fake.calls.at(-1)?.httpStatus, 0);
});

test("malformed with holdsStamp: the submit answers 200 garbage, a re-send is a real 409 and the GET answers the stamp", async () => {
  const { inv, key } = submission();
  fake.script(inv.invoiceNumber, { outcome: "malformed", holdsStamp: true });
  const first = await post({ idempotencyKey: key, rail: "rail_primary", invoice: inv });
  assert.equal(first.status, 200);
  const garbage = (await first.json()) as Record<string, unknown>;
  assert.equal(garbage.irn, undefined, "not a stamp the profile defines");
  assert.equal(typeof garbage.stamp, "string");

  const again = await post({ idempotencyKey: key, rail: "rail_primary", invoice: inv });
  assert.equal(again.status, 409, "the rail DID stamp: the re-send is a duplicate");
  assert.equal(((await again.json()) as { code: string }).code, "MBS_DUPLICATE");

  const got = await lookup(key);
  assert.equal(got.status, 200);
  const stamp = (await got.json()) as { irn: string };
  assert.match(stamp.irn, /^IRN-[0-9A-F]{16}$/);
  assert.deepEqual(stamp, fake.held.get(key));
  assert.deepEqual(
    fake.calls.filter((c) => c.idempotencyKey === key).map((c) => c.outcome),
    ["malformed", "duplicate", "lookup_hit"],
  );

  // Without holdsStamp nothing is held: the GET misses and a re-send is accepted afresh.
  const orphan = submission();
  fake.script(orphan.inv.invoiceNumber, { outcome: "malformed", times: 1 });
  const m = await post({ idempotencyKey: orphan.key, rail: "rail_primary", invoice: orphan.inv });
  assert.equal(m.status, 200);
  await m.text();
  const miss = await lookup(orphan.key);
  assert.equal(miss.status, 404);
  await miss.text();
  const resend = await post({ idempotencyKey: orphan.key, rail: "rail_primary", invoice: orphan.inv });
  assert.equal(resend.status, 201);
  await resend.text();
});

test("a scripted rate_limit carries the Retry-After it was given, in-process and over the control endpoint", async () => {
  const a = submission();
  fake.script(a.inv.invoiceNumber, { outcome: "rate_limit", retryAfterSeconds: 30, times: 1 });
  const ra = await post({ idempotencyKey: a.key, rail: "rail_primary", invoice: a.inv });
  assert.equal(ra.status, 429);
  assert.equal(ra.headers.get("retry-after"), "30");
  assert.equal(((await ra.json()) as { code: string }).code, "RAIL_RATE_LIMITED");

  const b = submission();
  const queued = await control("PUT", "/__fake/script", {
    invoiceNumber: b.inv.invoiceNumber,
    outcome: "rate_limit",
    retryAfterSeconds: 7.9,
    times: 1,
  });
  assert.equal(queued.status, 204);
  const rb = await post({ idempotencyKey: b.key, rail: "rail_primary", invoice: b.inv });
  assert.equal(rb.status, 429);
  assert.equal(rb.headers.get("retry-after"), "7", "whole seconds on the wire");
  await rb.text();
});

// ---- The fake's own limits answer 413/500, never a business rejection ----

test("a 2 MB submission is 413 with connection: close, and the next request on a fresh fetch succeeds", async () => {
  const { inv, key } = submission();
  const huge = await post({
    idempotencyKey: key,
    rail: "rail_primary",
    invoice: inv,
    padding: "x".repeat(2 * 1024 * 1024),
  });
  assert.equal(huge.status, 413);
  assert.equal(huge.headers.get("connection"), "close");
  assert.equal(((await huge.json()) as { code: string }).code, "PAYLOAD_TOO_LARGE");
  assert.equal(fake.calls.at(-1)?.outcome, "too_large");
  assert.equal(fake.calls.at(-1)?.httpStatus, 413);
  assert.equal(fake.held.has(key), false, "nothing was stamped");

  const next = await post({ idempotencyKey: key, rail: "rail_primary", invoice: inv });
  assert.equal(next.status, 201, "the rail still serves after dropping that connection");
  await next.text();
  assert.equal(fake.calls.at(-1)?.outcome, "accept");
});

test("an unreadable submission body is the fake's own 500, never a 400/422 the profile reserves for the invoice", async () => {
  const resp = await fetch(`${fake.url}/v0/submissions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: "{not json",
  });
  assert.equal(resp.status, 500);
  assert.equal(resp.headers.get("connection"), "close");
  assert.equal(((await resp.json()) as { code: string }).code, "UNREADABLE_BODY");
  assert.equal(fake.calls.at(-1)?.outcome, "unreadable");
});

test("PUT /__fake/script accepts op lookup and refuses an unknown op", async () => {
  const bad = await control("PUT", "/__fake/script", { invoiceNumber: "X", outcome: "unavailable", op: "nope" });
  assert.equal(bad.status, 400);
  await bad.text();

  const { inv, key } = submission();
  const ok = await control("PUT", "/__fake/script", {
    invoiceNumber: inv.invoiceNumber,
    outcome: "unavailable",
    op: "lookup",
    times: 1,
  });
  assert.equal(ok.status, 204);
  const posted = await post({ idempotencyKey: key, rail: "rail_primary", invoice: inv });
  assert.equal(posted.status, 201, "a lookup-op script leaves the submit alone");
  await posted.text();
  const got = await lookup(key);
  assert.equal(got.status, 503);
  await got.text();
  assert.equal(fake.calls.at(-1)?.outcome, "lookup_unavailable");
});
