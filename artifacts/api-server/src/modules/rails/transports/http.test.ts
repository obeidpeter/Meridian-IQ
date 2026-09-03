import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Rail } from "@workspace/db";
import { sampleCanonical } from "../../../test-helpers/canonical.ts";
import { startFakeRail, type FakeRail } from "../fake-rail.ts";
import {
  createHttpRailTransport,
  httpRailConfigFromEnv,
  railTimeoutMs,
  type HttpRailConfig,
} from "./http.ts";

// The HTTP transport's fault matrix (R95), pinned against the conformance
// fake rail in-process: every wire outcome the profile defines lands on
// exactly one failure-class code, credentials and the idempotency key travel
// on the wire, provenance is the transport's (never inferred), and neither a
// silent nor an unreachable access point can throw past the seam.

let fake: FakeRail;
const TOKEN = "t0k3n-primary";

before(async () => {
  fake = await startFakeRail({ token: TOKEN });
});
after(async () => {
  await fake.close();
});

function cfg(overrides: Partial<HttpRailConfig> = {}): HttpRailConfig {
  return {
    urls: { rail_primary: fake.url },
    tokens: { rail_primary: TOKEN },
    environment: "sandbox",
    timeoutMs: 2_000,
    ...overrides,
  };
}

let seq = 0;
function submission() {
  seq += 1;
  const inv = sampleCanonical(`INV-HTTP-${process.pid}-${seq}`);
  return { inv, key: `${randomUUID()}:${inv.invoiceNumber}` };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test("accepted: the bearer token and idempotency key travel on the wire, the stamp is mapped, provenance is the transport's", async () => {
  const transport = createHttpRailTransport(cfg({ environment: "live" }));
  const { inv, key } = submission();
  const result = await transport.submit("rail_primary", inv, key);
  assert.equal(result.status, "accepted");
  assert.match(result.irn ?? "", /^IRN-[0-9A-F]{16}$/);
  assert.equal(result.csid?.length, 24);
  assert.ok(result.qrPayload && result.signedArtifactRef);
  assert.equal(result.provider, "http");
  assert.equal(result.environment, "live");
  assert.equal(result.rail, "rail_primary");
  assert.equal((result.raw as { httpStatus: number }).httpStatus, 201);
  const call = fake.calls.at(-1);
  assert.equal(call?.authorized, true);
  assert.equal(call?.idempotencyHeader, key);
  assert.equal(call?.idempotencyKey, key);
  assert.equal(call?.invoiceNumber, inv.invoiceNumber);
  assert.equal(call?.rail, "rail_primary");
});

test("the served rails are the ones with a URL; an unserved rail answers RAIL_UNAVAILABLE without a call", async () => {
  const transport = createHttpRailTransport(cfg());
  assert.deepEqual(transport.rails, ["rail_primary"]);
  const before = fake.calls.length;
  const { inv, key } = submission();
  const result = await transport.submit("rail_secondary", inv, key);
  assert.equal(result.status, "error");
  assert.equal(result.errorCode, "RAIL_UNAVAILABLE");
  assert.equal(fake.calls.length, before, "nothing was sent");
  assert.equal(await transport.lookup("rail_secondary", inv, key), null);
  const both = createHttpRailTransport(
    cfg({ urls: { rail_primary: fake.url, rail_secondary: fake.url } }),
  );
  assert.deepEqual(both.rails, ["rail_primary", "rail_secondary"]);
});

test("422 with a code is a terminal rejection carrying that code; an unsafe code falls back to MBS_SCHEMA_INVALID", async () => {
  const transport = createHttpRailTransport(cfg());
  const a = submission();
  fake.script(a.inv.invoiceNumber, { outcome: "reject", code: "MBS_INVALID_TIN" });
  const rejected = await transport.submit("rail_primary", a.inv, a.key);
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.errorCode, "MBS_INVALID_TIN");
  assert.equal((rejected.raw as { httpStatus: number }).httpStatus, 422);
  assert.equal(
    (rejected.raw as { body: { code: string } }).body.code,
    "MBS_INVALID_TIN",
    "the attempts table keeps the body",
  );
  const b = submission();
  fake.script(b.inv.invoiceNumber, { outcome: "reject", code: "not a code!" });
  const fallback = await transport.submit("rail_primary", b.inv, b.key);
  assert.equal(fallback.status, "rejected");
  assert.equal(fallback.errorCode, "MBS_SCHEMA_INVALID");
});

test("409 is MBS_DUPLICATE; lookup recovers a stamp only when the rail holds one", async () => {
  const transport = createHttpRailTransport(cfg());
  const orphan = submission();
  fake.script(orphan.inv.invoiceNumber, { outcome: "duplicate" });
  const dup = await transport.submit("rail_primary", orphan.inv, orphan.key);
  assert.equal(dup.status, "rejected");
  assert.equal(dup.errorCode, "MBS_DUPLICATE");
  assert.equal(await transport.lookup("rail_primary", orphan.inv, orphan.key), null);

  const held = submission();
  fake.script(held.inv.invoiceNumber, { outcome: "duplicate", holdsStamp: true });
  const dup2 = await transport.submit("rail_primary", held.inv, held.key);
  assert.equal(dup2.errorCode, "MBS_DUPLICATE");
  const recovered = await transport.lookup("rail_primary", held.inv, held.key);
  assert.equal(recovered?.status, "accepted");
  assert.match(recovered?.irn ?? "", /^IRN-/);
  assert.equal(recovered?.provider, "http");
  assert.equal((recovered?.raw as { lookedUp: boolean }).lookedUp, true);
});

test("a key the rail already accepted is a duplicate on re-send and the same stamp on lookup", async () => {
  const transport = createHttpRailTransport(cfg());
  const { inv, key } = submission();
  const first = await transport.submit("rail_primary", inv, key);
  assert.equal(first.status, "accepted");
  const again = await transport.submit("rail_primary", inv, key);
  assert.equal(again.status, "rejected");
  assert.equal(again.errorCode, "MBS_DUPLICATE");
  const found = await transport.lookup("rail_primary", inv, key);
  assert.equal(found?.irn, first.irn);
  assert.equal(found?.csid, first.csid);
});

test("429, 503, a scripted 401 and a non-conforming 2xx map to their retriable codes", async () => {
  const transport = createHttpRailTransport(cfg());
  const cells: Array<["rate_limit" | "unavailable" | "unauthorized" | "malformed", string, number]> = [
    ["rate_limit", "RAIL_RATE_LIMITED", 429],
    ["unavailable", "RAIL_UNAVAILABLE", 503],
    ["unauthorized", "RAIL_UNAUTHORIZED", 401],
    ["malformed", "RAIL_PROTOCOL", 200],
  ];
  for (const [outcome, code, httpStatus] of cells) {
    const { inv, key } = submission();
    fake.script(inv.invoiceNumber, { outcome });
    const result = await transport.submit("rail_primary", inv, key);
    assert.equal(result.status, "error", outcome);
    assert.equal(result.errorCode, code, outcome);
    assert.equal((result.raw as { httpStatus: number }).httpStatus, httpStatus, outcome);
  }
});

test("a wrong bearer token is RAIL_UNAUTHORIZED on submit and null on lookup", async () => {
  const transport = createHttpRailTransport(cfg({ tokens: { rail_primary: "wrong" } }));
  const { inv, key } = submission();
  const result = await transport.submit("rail_primary", inv, key);
  assert.equal(result.status, "error");
  assert.equal(result.errorCode, "RAIL_UNAUTHORIZED");
  assert.equal(fake.calls.at(-1)?.authorized, false);
  assert.equal(await transport.lookup("rail_primary", inv, key), null);
});

test("a silent access point is RAIL_TIMEOUT within the configured budget", async () => {
  const transport = createHttpRailTransport(cfg({ timeoutMs: 200 }));
  const { inv, key } = submission();
  fake.script(inv.invoiceNumber, { outcome: "timeout" });
  const started = Date.now();
  const result = await transport.submit("rail_primary", inv, key);
  const elapsed = Date.now() - started;
  assert.equal(result.status, "error");
  assert.equal(result.errorCode, "RAIL_TIMEOUT");
  assert.equal((result.raw as { reason: string }).reason, "timeout");
  assert.ok(elapsed < 1_500, `gave up after ${elapsed}ms`);
});

test("an unreachable access point is RAIL_UNAVAILABLE and lookup answers null", async () => {
  const port = await freePort();
  const transport = createHttpRailTransport(
    cfg({ urls: { rail_primary: `http://127.0.0.1:${port}` } }),
  );
  const { inv, key } = submission();
  const result = await transport.submit("rail_primary", inv, key);
  assert.equal(result.status, "error");
  assert.equal(result.errorCode, "RAIL_UNAVAILABLE");
  assert.equal((result.raw as { reason: string }).reason, "network");
  assert.equal(await transport.lookup("rail_primary", inv, key), null);
});

test("lookup: a miss is null, a hit is the stamp the rail holds", async () => {
  const transport = createHttpRailTransport(cfg());
  const { inv, key } = submission();
  assert.equal(await transport.lookup("rail_primary", inv, key), null);
  assert.equal(fake.calls.at(-1)?.outcome, "lookup_miss");
  const accepted = await transport.submit("rail_primary", inv, key);
  const found = await transport.lookup("rail_primary", inv, key);
  assert.equal(fake.calls.at(-1)?.outcome, "lookup_hit");
  assert.equal(found?.irn, accepted.irn);
  assert.equal(found?.rail, "rail_primary");
});

test("httpRailConfigFromEnv: only lit rails, trailing slashes trimmed, sandbox and 10 s by default", () => {
  assert.equal(httpRailConfigFromEnv({}), null);
  assert.equal(httpRailConfigFromEnv({ RAIL_PRIMARY_TOKEN: "t" }), null, "a token alone lights nothing");
  const primary = httpRailConfigFromEnv({
    RAIL_PRIMARY_URL: "https://rail.example/base/",
    RAIL_PRIMARY_TOKEN: " secret ",
  });
  assert.deepEqual(primary, {
    urls: { rail_primary: "https://rail.example/base" },
    tokens: { rail_primary: "secret" },
    environment: "sandbox",
    timeoutMs: 10_000,
  });
  const both = httpRailConfigFromEnv({
    RAIL_PRIMARY_URL: "https://a.example",
    RAIL_SECONDARY_URL: "https://b.example",
    RAIL_ENVIRONMENT: "live",
    RAIL_TIMEOUT_MS: "2500",
  });
  assert.deepEqual(both?.urls, { rail_primary: "https://a.example", rail_secondary: "https://b.example" });
  assert.deepEqual(both?.tokens, {});
  assert.equal(both?.environment, "live");
  assert.equal(both?.timeoutMs, 2_500);
  const rails = createHttpRailTransport(both!).rails as Rail[];
  assert.deepEqual(rails, ["rail_primary", "rail_secondary"]);
  assert.equal(railTimeoutMs({ RAIL_TIMEOUT_MS: "nope" }), 10_000);
  assert.equal(railTimeoutMs({ RAIL_TIMEOUT_MS: "-5" }), 10_000);
  assert.equal(railTimeoutMs({ RAIL_TIMEOUT_MS: "750.9" }), 750);
});
