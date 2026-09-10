import {
  test,
  describe,
  before,
  beforeEach,
  after,
  afterEach,
} from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { Socket } from "node:net";
import type { Rail } from "@workspace/db";
import { sampleCanonical } from "../../../test-helpers/canonical.ts";
import { startFakeRail, type FakeRail } from "../fake-rail.ts";
import { RailLookupError } from "../faults.ts";
import {
  MAX_TIMEOUT_MS,
  createHttpRailTransport,
  httpRailConfigFromEnv,
  railEnvironmentFromEnv,
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
  fake.script(a.inv.invoiceNumber, {
    outcome: "reject",
    code: "MBS_INVALID_TIN",
  });
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
  assert.equal((dup.raw as { httpStatus: number }).httpStatus, 409);
  assert.equal(
    await transport.lookup("rail_primary", orphan.inv, orphan.key),
    null,
  );

  const held = submission();
  fake.script(held.inv.invoiceNumber, {
    outcome: "duplicate",
    holdsStamp: true,
  });
  const dup2 = await transport.submit("rail_primary", held.inv, held.key);
  assert.equal(dup2.errorCode, "MBS_DUPLICATE");
  assert.equal((dup2.raw as { httpStatus: number }).httpStatus, 409);
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
  const cells: Array<
    [
      "rate_limit" | "unavailable" | "unauthorized" | "malformed",
      string,
      number,
    ]
  > = [
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
    assert.equal(
      (result.raw as { httpStatus: number }).httpStatus,
      httpStatus,
      outcome,
    );
  }
});

test("a wrong bearer token is RAIL_UNAUTHORIZED on submit and a RailLookupError on lookup — never a miss", async () => {
  const transport = createHttpRailTransport(
    cfg({ tokens: { rail_primary: "wrong" } }),
  );
  const { inv, key } = submission();
  const result = await transport.submit("rail_primary", inv, key);
  assert.equal(result.status, "error");
  assert.equal(result.errorCode, "RAIL_UNAUTHORIZED");
  assert.equal(fake.calls.at(-1)?.authorized, false);
  await assert.rejects(
    transport.lookup("rail_primary", inv, key),
    (err: unknown) =>
      err instanceof RailLookupError && err.code === "RAIL_UNAUTHORIZED",
  );
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

test("an unreachable access point is RAIL_UNAVAILABLE on submit and a RailLookupError on lookup", async () => {
  const port = await freePort();
  const transport = createHttpRailTransport(
    cfg({ urls: { rail_primary: `http://127.0.0.1:${port}` } }),
  );
  const { inv, key } = submission();
  const result = await transport.submit("rail_primary", inv, key);
  assert.equal(result.status, "error");
  assert.equal(result.errorCode, "RAIL_UNAVAILABLE");
  assert.deepEqual(result.raw, {
    httpStatus: 0,
    body: null,
    reason: "network",
    timeoutMs: 2_000,
  });
  await assert.rejects(
    transport.lookup("rail_primary", inv, key),
    (err: unknown) =>
      err instanceof RailLookupError && err.code === "RAIL_UNAVAILABLE",
  );
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

test("httpRailConfigFromEnv: only lit rails, trailing slashes trimmed, sandbox and 5 s by default", () => {
  assert.equal(httpRailConfigFromEnv({}), null);
  assert.equal(
    httpRailConfigFromEnv({ RAIL_PRIMARY_TOKEN: "t" }),
    null,
    "a token alone lights nothing",
  );
  const primary = httpRailConfigFromEnv({
    RAIL_PRIMARY_URL: "https://rail.example/base/",
    RAIL_PRIMARY_TOKEN: " secret ",
  });
  assert.deepEqual(primary, {
    urls: { rail_primary: "https://rail.example/base" },
    tokens: { rail_primary: "secret" },
    environment: "sandbox",
    timeoutMs: 5_000,
  });
  const both = httpRailConfigFromEnv({
    RAIL_PRIMARY_URL: "https://a.example",
    RAIL_SECONDARY_URL: "https://b.example",
    RAIL_ENVIRONMENT: "live",
    RAIL_TIMEOUT_MS: "2500",
  });
  assert.deepEqual(both?.urls, {
    rail_primary: "https://a.example",
    rail_secondary: "https://b.example",
  });
  assert.deepEqual(both?.tokens, {});
  assert.equal(both?.environment, "live");
  assert.equal(both?.timeoutMs, 2_500);
  const rails = createHttpRailTransport(both!).rails as Rail[];
  assert.deepEqual(rails, ["rail_primary", "rail_secondary"]);
  assert.equal(railTimeoutMs({ RAIL_TIMEOUT_MS: "nope" }), 5_000);
  assert.equal(railTimeoutMs({ RAIL_TIMEOUT_MS: "-5" }), 5_000);
  assert.equal(railTimeoutMs({ RAIL_TIMEOUT_MS: "750.9" }), 750);
});

// ---- An ad-hoc access point that answers whatever the case says ----
//
// The conformance fake speaks the profile correctly by construction; the
// cells below need a rail that does NOT — odd statuses, redirects, oversized
// or poisoned bodies, stamps out of bounds, a body that never ends. One stub
// per test on an ephemeral port; afterEach tears down every socket it holds
// (a stalled response included) so nothing outlives the test.

interface StubAnswer {
  status: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Send the status line, the headers and `body`, then never end the response. */
  stall?: boolean;
}

interface StubRail {
  readonly url: string;
  readonly hits: number;
  readonly requests: Array<{
    method: string;
    path: string;
    headers: IncomingHttpHeaders;
  }>;
  answer(next: StubAnswer): void;
  close(): Promise<void>;
}

async function startStub(): Promise<StubRail> {
  let next: StubAnswer = { status: 500 };
  const sockets = new Set<Socket>();
  const requests: StubRail["requests"] = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        path: req.url ?? "",
        headers: req.headers,
      });
      const answer = next;
      const body =
        answer.body === undefined
          ? Buffer.alloc(0)
          : Buffer.isBuffer(answer.body)
            ? answer.body
            : Buffer.from(answer.body, "utf8");
      if (answer.stall) {
        res.writeHead(answer.status, answer.headers ?? {});
        res.flushHeaders();
        if (body.length > 0) res.write(body);
        return;
      }
      res.writeHead(answer.status, {
        "content-length": String(body.length),
        ...(answer.headers ?? {}),
      });
      res.end(body);
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    get hits() {
      return requests.length;
    },
    requests,
    answer(answer) {
      next = answer;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const json = (value: unknown): string => JSON.stringify(value);

// Spelled from char codes so the test source itself carries no control bytes.
const NUL = String.fromCharCode(0);
const BEL = String.fromCharCode(7);

type StampBody = Record<
  "irn" | "csid" | "qrPayload" | "signedArtifactRef",
  string
>;

function conformingBody(overrides: Partial<StampBody> = {}): StampBody {
  return {
    irn: "IRN-0123456789ABCDEF",
    csid: "c".repeat(24),
    qrPayload: Buffer.from(json({ irn: "IRN-0123456789ABCDEF" })).toString(
      "base64",
    ),
    signedArtifactRef: "c2lnbmVk",
    ...overrides,
  };
}

/** Any NUL character anywhere in a value the attempts table would receive. */
function hasNul(value: unknown): boolean {
  if (typeof value === "string") return value.includes(NUL);
  if (Array.isArray(value)) return value.some(hasNul);
  if (value && typeof value === "object") {
    return Object.entries(value).some(([k, v]) => hasNul(k) || hasNul(v));
  }
  return false;
}

describe("the wire matrix, cell by cell, against an ad-hoc stub", () => {
  let stub: StubRail;
  let other: StubRail | null = null;

  beforeEach(async () => {
    stub = await startStub();
  });
  afterEach(async () => {
    await stub.close();
    if (other) {
      await other.close();
      other = null;
    }
  });

  function transport(overrides: Partial<HttpRailConfig> = {}) {
    return createHttpRailTransport(
      cfg({ urls: { rail_primary: stub.url }, ...overrides }),
    );
  }

  interface SubmitCell {
    name: string;
    answer: StubAnswer;
    status: "accepted" | "rejected" | "error";
    code?: string;
    /** When present, what raw.body must equal. */
    body?: unknown;
  }

  const SUBMIT_CELLS: SubmitCell[] = [
    {
      name: "400 with a code is a rejection carrying it (E-1001)",
      answer: {
        status: 400,
        body: json({ code: "E-1001", message: "bad request" }),
      },
      status: "rejected",
      code: "E-1001",
    },
    {
      name: "400 without a code is RAIL_PROTOCOL, not a rejection",
      answer: { status: 400, body: json({ message: "bad request" }) },
      status: "error",
      code: "RAIL_PROTOCOL",
    },
    {
      name: "422 with no body is rejected MBS_SCHEMA_INVALID",
      answer: { status: 422 },
      status: "rejected",
      code: "MBS_SCHEMA_INVALID",
      body: null,
    },
    {
      name: "422 with a 65-char code falls back to MBS_SCHEMA_INVALID",
      answer: { status: 422, body: json({ code: "X".repeat(65) }) },
      status: "rejected",
      code: "MBS_SCHEMA_INVALID",
    },
    {
      name: "422 with mbs.invalid_tin keeps the dotted code (the relaxed charset)",
      answer: { status: 422, body: json({ code: "mbs.invalid_tin" }) },
      status: "rejected",
      code: "mbs.invalid_tin",
    },
    {
      name: "403 is RAIL_UNAUTHORIZED",
      answer: { status: 403, body: json({ code: "FORBIDDEN" }) },
      status: "error",
      code: "RAIL_UNAUTHORIZED",
    },
    {
      name: "404 is RAIL_PROTOCOL",
      answer: { status: 404 },
      status: "error",
      code: "RAIL_PROTOCOL",
    },
    {
      name: "418 is RAIL_PROTOCOL",
      answer: { status: 418, body: "short and stout" },
      status: "error",
      code: "RAIL_PROTOCOL",
      body: "short and stout",
    },
    {
      name: "500 is RAIL_UNAVAILABLE",
      answer: { status: 500 },
      status: "error",
      code: "RAIL_UNAVAILABLE",
    },
    {
      name: "502 is RAIL_UNAVAILABLE",
      answer: { status: 502, body: "<html>bad gateway</html>" },
      status: "error",
      code: "RAIL_UNAVAILABLE",
    },
    {
      name: "409 with an empty body is MBS_DUPLICATE with raw.body null",
      answer: { status: 409 },
      status: "rejected",
      code: "MBS_DUPLICATE",
      body: null,
    },
    {
      name: "409 with a text body is MBS_DUPLICATE with raw.body the text",
      answer: { status: 409, body: "already stamped" },
      status: "rejected",
      code: "MBS_DUPLICATE",
      body: "already stamped",
    },
    {
      name: "202 with a conforming body is accepted",
      answer: { status: 202, body: json(conformingBody()) },
      status: "accepted",
    },
  ];

  for (const cell of SUBMIT_CELLS) {
    test(`submit: ${cell.name}`, async () => {
      stub.answer(cell.answer);
      const { inv, key } = submission();
      const result = await transport().submit("rail_primary", inv, key);
      assert.equal(result.status, cell.status);
      if (cell.status === "accepted") {
        assert.equal(result.irn, conformingBody().irn);
        assert.equal(result.provider, "http");
      } else {
        assert.equal(result.errorCode, cell.code);
      }
      const raw = result.raw as { httpStatus: number; body: unknown };
      assert.equal(raw.httpStatus, cell.answer.status);
      if ("body" in cell) assert.deepEqual(raw.body, cell.body);
      assert.equal(stub.hits, 1);
      assert.equal(stub.requests[0]?.method, "POST");
      assert.equal(stub.requests[0]?.path, "/v0/submissions");
      assert.equal(stub.requests[0]?.headers["idempotency-key"], key);
    });
  }

  for (const status of [302, 307]) {
    test(`submit: ${status} with a Location is RAIL_PROTOCOL and the redirect is never followed`, async () => {
      other = await startStub();
      other.answer({ status: 201, body: json(conformingBody()) });
      stub.answer({
        status,
        headers: { location: `${other.url}/v0/submissions` },
      });
      const { inv, key } = submission();
      const result = await transport().submit("rail_primary", inv, key);
      assert.equal(result.status, "error");
      assert.equal(result.errorCode, "RAIL_PROTOCOL");
      assert.equal((result.raw as { httpStatus: number }).httpStatus, status);
      assert.equal(stub.hits, 1);
      assert.equal(other.hits, 0, "the redirect target was never called");
    });
  }

  test("submit: 429 with Retry-After 30 carries raw.retryAfterMs 30000", async () => {
    stub.answer({
      status: 429,
      headers: { "retry-after": "30" },
      body: json({ code: "SLOW_DOWN" }),
    });
    const { inv, key } = submission();
    const result = await transport().submit("rail_primary", inv, key);
    assert.equal(result.errorCode, "RAIL_RATE_LIMITED");
    assert.equal((result.raw as { retryAfterMs: number }).retryAfterMs, 30_000);
  });

  test("submit: 429 with an HTTP-date Retry-After ~45 s ahead lands within [40000, 50000]", async () => {
    stub.answer({
      status: 429,
      headers: { "retry-after": new Date(Date.now() + 45_000).toUTCString() },
    });
    const { inv, key } = submission();
    const result = await transport().submit("rail_primary", inv, key);
    assert.equal(result.errorCode, "RAIL_RATE_LIMITED");
    const retryAfterMs = (result.raw as { retryAfterMs: number }).retryAfterMs;
    assert.ok(
      retryAfterMs >= 40_000 && retryAfterMs <= 50_000,
      `retryAfterMs ${retryAfterMs}`,
    );
  });

  test("submit: 429 with Retry-After 999999 is capped at one hour", async () => {
    stub.answer({ status: 429, headers: { "retry-after": "999999" } });
    const { inv, key } = submission();
    const result = await transport().submit("rail_primary", inv, key);
    assert.equal(result.errorCode, "RAIL_RATE_LIMITED");
    assert.equal(
      (result.raw as { retryAfterMs: number }).retryAfterMs,
      3_600_000,
    );
  });

  test("submit: 429 without Retry-After carries no retryAfterMs at all", async () => {
    stub.answer({ status: 429, body: json({ code: "SLOW_DOWN" }) });
    const { inv, key } = submission();
    const result = await transport().submit("rail_primary", inv, key);
    assert.equal(result.errorCode, "RAIL_RATE_LIMITED");
    assert.equal("retryAfterMs" in (result.raw as object), false);
    assert.deepEqual(result.raw, {
      httpStatus: 429,
      body: { code: "SLOW_DOWN" },
    });
  });

  // ---- Body hardening: what the attempts table may receive ----

  test("body: a 200 of 200 KiB is RAIL_PROTOCOL, marked truncated, and retains at most 4 KiB", async () => {
    stub.answer({ status: 200, body: "x".repeat(200 * 1024) });
    const { inv, key } = submission();
    const result = await transport().submit("rail_primary", inv, key);
    assert.equal(result.status, "error");
    assert.equal(result.errorCode, "RAIL_PROTOCOL");
    const raw = result.raw as {
      httpStatus: number;
      body: unknown;
      truncated?: boolean;
    };
    assert.equal(raw.httpStatus, 200);
    assert.equal(raw.truncated, true);
    assert.equal(typeof raw.body, "string");
    assert.ok(
      (raw.body as string).length <= 4_096,
      `retained ${(raw.body as string).length} chars`,
    );
  });

  test("body: a 503 whose JSON body carries a raw NUL byte leaves no NUL in raw.body", async () => {
    stub.answer({
      status: 503,
      headers: { "content-type": "application/json" },
      body: Buffer.from(`{"code":"RAIL_DOWN","detail":"x${NUL}y"}`, "utf8"),
    });
    const { inv, key } = submission();
    const result = await transport().submit("rail_primary", inv, key);
    assert.equal(result.errorCode, "RAIL_UNAVAILABLE");
    const raw = result.raw as { httpStatus: number; body: unknown };
    assert.equal(raw.httpStatus, 503);
    assert.equal(hasNul(raw.body), false, json(raw.body));
    assert.equal(
      json(raw).includes("\\u0000"),
      false,
      "nothing jsonb would refuse",
    );
    assert.deepEqual(raw.body, { code: "RAIL_DOWN", detail: "xy" });
  });

  test("body: a 503 whose JSON body carries the escaped \\u0000 leaves no NUL in raw.body", async () => {
    // Valid JSON can only spell NUL this way — and it is exactly the escape a
    // jsonb column refuses, so it must not survive into the persisted body.
    stub.answer({
      status: 503,
      headers: { "content-type": "application/json" },
      body: '{"code":"RAIL_DOWN","detail":"x\\u0000y"}',
    });
    const { inv, key } = submission();
    const result = await transport().submit("rail_primary", inv, key);
    assert.equal(result.errorCode, "RAIL_UNAVAILABLE");
    const raw = result.raw as { httpStatus: number; body: unknown };
    assert.equal(raw.httpStatus, 503);
    assert.equal(hasNul(raw.body), false, json(raw.body));
    assert.equal(
      json(raw).includes("\\u0000"),
      false,
      "nothing jsonb would refuse",
    );
  });

  test("body: a 503 of 20 000 nested brackets is retained as bounded text and stringifies", async () => {
    stub.answer({ status: 503, body: "[".repeat(20_000) + "]".repeat(20_000) });
    const { inv, key } = submission();
    const result = await transport().submit("rail_primary", inv, key);
    assert.equal(result.errorCode, "RAIL_UNAVAILABLE");
    const raw = result.raw as { httpStatus: number; body: unknown };
    assert.equal(raw.httpStatus, 503);
    assert.equal(typeof raw.body, "string", "never the parsed object");
    assert.ok((raw.body as string).length <= 4_096);
    assert.doesNotThrow(() => json(result.raw));
  });

  test("body: a 401 that echoes the bearer token keeps [redacted], never the token", async () => {
    stub.answer({
      status: 401,
      body: json({ error: `token ${TOKEN} is not known here` }),
    });
    const { inv, key } = submission();
    const result = await transport().submit("rail_primary", inv, key);
    assert.equal(result.errorCode, "RAIL_UNAUTHORIZED");
    const persisted = json((result.raw as { body: unknown }).body);
    assert.ok(persisted.includes("[redacted]"), persisted);
    assert.equal(
      persisted.includes(TOKEN),
      false,
      "the bearer never reaches the attempts table",
    );
    assert.equal(
      stub.requests[0]?.headers.authorization,
      `Bearer ${TOKEN}`,
      "it did travel on the wire",
    );
  });

  test("body: a 200 that never ends its body is RAIL_TIMEOUT in phase body within the budget", async () => {
    stub.answer({
      status: 200,
      headers: { "content-type": "application/json" },
      body: '{"irn":"IRN-0123',
      stall: true,
    });
    const { inv, key } = submission();
    const started = Date.now();
    const result = await transport({ timeoutMs: 300 }).submit(
      "rail_primary",
      inv,
      key,
    );
    const elapsed = Date.now() - started;
    assert.equal(result.status, "error");
    assert.equal(result.errorCode, "RAIL_TIMEOUT");
    assert.ok(elapsed < 2_000, `gave up after ${elapsed}ms`);
    assert.deepEqual(result.raw, {
      httpStatus: 200,
      body: null,
      reason: "timeout",
      timeoutMs: 300,
      phase: "body",
    });
  });

  // ---- Stamp validation: what an accepted body may carry ----

  const BAD_STAMPS: Array<[string, Partial<StampBody>]> = [
    ["an irn with a control character", { irn: `IRN-0123${BEL}ABCD` }],
    ["a qrPayload of 3000 chars", { qrPayload: "A".repeat(3_000) }],
    ["a csid of 129 chars", { csid: "c".repeat(129) }],
    ["a qrPayload containing a space", { qrPayload: "QUJD REVG" }],
  ];

  for (const [name, overrides] of BAD_STAMPS) {
    test(`stamp: a 201 with ${name} is RAIL_PROTOCOL`, async () => {
      stub.answer({ status: 201, body: json(conformingBody(overrides)) });
      const { inv, key } = submission();
      const result = await transport().submit("rail_primary", inv, key);
      assert.equal(result.status, "error");
      assert.equal(result.errorCode, "RAIL_PROTOCOL");
      assert.equal((result.raw as { httpStatus: number }).httpStatus, 201);
      assert.equal(result.irn, undefined);
    });
  }

  test("stamp: a 201 with a qrPayload of exactly 2900 base64 chars and an irn of 128 chars is accepted", async () => {
    const body = conformingBody({
      qrPayload: "A".repeat(2_900),
      irn: "I".repeat(128),
    });
    stub.answer({ status: 201, body: json(body) });
    const { inv, key } = submission();
    const result = await transport().submit("rail_primary", inv, key);
    assert.equal(result.status, "accepted");
    assert.equal(result.qrPayload?.length, 2_900);
    assert.equal(result.irn?.length, 128);
    assert.equal(result.csid, body.csid);
    assert.equal(result.signedArtifactRef, body.signedArtifactRef);
  });

  // ---- Lookup: a definite miss is null, everything else that is not the stamp throws ----

  const LOOKUP_CELLS: Array<{
    name: string;
    answer: StubAnswer;
    code: string;
  }> = [
    {
      name: "503 is RAIL_UNAVAILABLE",
      answer: { status: 503 },
      code: "RAIL_UNAVAILABLE",
    },
    {
      name: "401 is RAIL_UNAUTHORIZED",
      answer: { status: 401 },
      code: "RAIL_UNAUTHORIZED",
    },
    {
      name: "429 is RAIL_RATE_LIMITED",
      answer: { status: 429, headers: { "retry-after": "5" } },
      code: "RAIL_RATE_LIMITED",
    },
    {
      name: "418 is RAIL_PROTOCOL",
      answer: { status: 418 },
      code: "RAIL_PROTOCOL",
    },
    {
      name: "a 200 that is not a stamp is RAIL_PROTOCOL",
      answer: {
        status: 200,
        body: json({ stamp: "not the shape the profile defines" }),
      },
      code: "RAIL_PROTOCOL",
    },
  ];

  for (const cell of LOOKUP_CELLS) {
    test(`lookup: ${cell.name} — a RailLookupError, never a miss`, async () => {
      stub.answer(cell.answer);
      const { inv, key } = submission();
      await assert.rejects(
        transport().lookup("rail_primary", inv, key),
        (err: unknown) =>
          err instanceof RailLookupError &&
          err.code === cell.code &&
          err.rail === "rail_primary",
      );
      assert.equal(stub.hits, 1);
      assert.equal(stub.requests[0]?.method, "GET");
      assert.equal(
        stub.requests[0]?.path,
        `/v0/submissions/${encodeURIComponent(key)}`,
      );
    });
  }

  test("lookup: 404 is null — the one definite miss", async () => {
    stub.answer({ status: 404, body: json({ code: "NOT_FOUND" }) });
    const { inv, key } = submission();
    assert.equal(await transport().lookup("rail_primary", inv, key), null);
    assert.equal(stub.hits, 1);
  });

  test("lookup: 302 is RailLookupError RAIL_PROTOCOL and the redirect is never followed", async () => {
    other = await startStub();
    other.answer({ status: 200, body: json(conformingBody()) });
    stub.answer({
      status: 302,
      headers: { location: `${other.url}/v0/submissions/x` },
    });
    const { inv, key } = submission();
    await assert.rejects(
      transport().lookup("rail_primary", inv, key),
      (err: unknown) =>
        err instanceof RailLookupError && err.code === "RAIL_PROTOCOL",
    );
    assert.equal(stub.hits, 1);
    assert.equal(other.hits, 0, "the redirect target was never called");
  });

  test("lookup: a body that never ends is RailLookupError RAIL_TIMEOUT within the budget", async () => {
    stub.answer({
      status: 200,
      headers: { "content-type": "application/json" },
      body: '{"irn":"IRN-0123',
      stall: true,
    });
    const { inv, key } = submission();
    const started = Date.now();
    await assert.rejects(
      transport({ timeoutMs: 300 }).lookup("rail_primary", inv, key),
      (err: unknown) =>
        err instanceof RailLookupError && err.code === "RAIL_TIMEOUT",
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2_000, `gave up after ${elapsed}ms`);
  });
});

// ---- Configuration: what a rail URL must look like before a credential goes to it ----

test("httpRailConfigFromEnv: a URL with credentials, a non-URL or a non-http(s) scheme leaves the rail unconfigured", () => {
  assert.equal(
    httpRailConfigFromEnv({ RAIL_PRIMARY_URL: "http://user:pw@rail.example" }),
    null,
  );
  assert.equal(httpRailConfigFromEnv({ RAIL_PRIMARY_URL: "not a url" }), null);
  assert.equal(httpRailConfigFromEnv({ RAIL_PRIMARY_URL: "ftp://x" }), null);
  const mixed = httpRailConfigFromEnv({
    RAIL_PRIMARY_URL: "ftp://x",
    RAIL_SECONDARY_URL: "https://b.example/",
  });
  assert.deepEqual(
    mixed?.urls,
    { rail_secondary: "https://b.example" },
    "one bad URL does not darken the other rail",
  );
});

test("httpRailConfigFromEnv: plain http is refused in production except to loopback; https is fine", () => {
  assert.equal(
    httpRailConfigFromEnv({
      RAIL_PRIMARY_URL: "http://rail.example",
      NODE_ENV: "production",
    }),
    null,
  );
  assert.deepEqual(
    httpRailConfigFromEnv({
      RAIL_PRIMARY_URL: "http://127.0.0.1:9",
      NODE_ENV: "production",
    })?.urls,
    { rail_primary: "http://127.0.0.1:9" },
  );
  assert.deepEqual(
    httpRailConfigFromEnv({
      RAIL_PRIMARY_URL: "https://rail.example",
      NODE_ENV: "production",
    })?.urls,
    { rail_primary: "https://rail.example" },
  );
  assert.deepEqual(
    httpRailConfigFromEnv({
      RAIL_PRIMARY_URL: "http://rail.example",
      NODE_ENV: "test",
    })?.urls,
    { rail_primary: "http://rail.example" },
    "outside production a plain-http staging rail is tolerated",
  );
});

test("RAIL_ENVIRONMENT is exactly sandbox|live; anything else keeps provenance on sandbox", () => {
  assert.equal(railEnvironmentFromEnv({ RAIL_ENVIRONMENT: "Live" }), "sandbox");
  assert.equal(railEnvironmentFromEnv({ RAIL_ENVIRONMENT: "prod" }), "sandbox");
  assert.equal(railEnvironmentFromEnv({ RAIL_ENVIRONMENT: "live" }), "live");
  assert.equal(
    railEnvironmentFromEnv({ RAIL_ENVIRONMENT: " live " }),
    "live",
    "trimmed",
  );
  assert.equal(railEnvironmentFromEnv({}), "sandbox");
  assert.equal(
    httpRailConfigFromEnv({
      RAIL_PRIMARY_URL: "https://a.example",
      RAIL_ENVIRONMENT: "Live",
    })?.environment,
    "sandbox",
  );
  assert.equal(
    httpRailConfigFromEnv({
      RAIL_PRIMARY_URL: "https://a.example",
      RAIL_ENVIRONMENT: "prod",
    })?.environment,
    "sandbox",
  );
  assert.equal(
    httpRailConfigFromEnv({
      RAIL_PRIMARY_URL: "https://a.example",
      RAIL_ENVIRONMENT: "live",
    })?.environment,
    "live",
  );
});

test("RAIL_TIMEOUT_MS is clamped to 60 s", () => {
  assert.equal(MAX_TIMEOUT_MS, 60_000);
  assert.equal(railTimeoutMs({ RAIL_TIMEOUT_MS: "999999" }), 60_000);
  assert.equal(railTimeoutMs({ RAIL_TIMEOUT_MS: "60000" }), 60_000);
  assert.equal(railTimeoutMs({ RAIL_TIMEOUT_MS: "59999" }), 59_999);
  assert.equal(
    httpRailConfigFromEnv({
      RAIL_PRIMARY_URL: "https://a.example",
      RAIL_TIMEOUT_MS: "999999",
    })?.timeoutMs,
    60_000,
  );
});
