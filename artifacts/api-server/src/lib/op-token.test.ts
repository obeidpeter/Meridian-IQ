import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Router, type IRouter } from "express";
import {
  authenticateOpRequest,
  opTokenAllows,
  parseKeyRing,
  railKeyRing,
  requireOpToken,
  signOpRequest,
  OP_KEY_ID_HEADER,
  OP_SIGNATURE_HEADER,
  OP_TIMESTAMP_HEADER,
} from "./op-token.ts";
import { JSON_HEADERS } from "../test-helpers/route-harness.ts";
import healthRouter from "../routes/health.ts";
import sweepRouter from "../routes/sweep.ts";
import type { Principal } from "../modules/auth/rbac.ts";
import {
  appFor,
  listen,
  closeAllServers,
} from "../test-helpers/route-harness.ts";
import { crossTenantPrincipal } from "../test-helpers/principals.ts";

// The operational-token guard accepts secrets from the x-op-token header
// only, keeping credentials out of URLs, access logs, and browser history.
// Env mutations here are safe: node:test runs this file in its own process
// and its tests serially.

const principal: Principal = crossTenantPrincipal("operator");

after(async () => {
  await closeAllServers();
});

test("opTokenAllows: no configured secret admits everyone", () => {
  assert.equal(opTokenAllows(undefined, undefined), true);
  assert.equal(opTokenAllows(undefined, "anything"), true);
  assert.equal(opTokenAllows("", "anything"), true);
});

test("opTokenAllows: a configured secret requires an exact match", () => {
  assert.equal(opTokenAllows("s3cret", "s3cret"), true);
  assert.equal(opTokenAllows("s3cret", undefined), false);
  assert.equal(opTokenAllows("s3cret", ""), false);
  assert.equal(opTokenAllows("s3cret", "s3creT"), false);
  assert.equal(opTokenAllows("s3cret", "s3cret-and-more"), false);
});

test("requireOpToken: open when unset; only the header admits once set", async () => {
  const guarded: IRouter = Router();
  guarded.get("/guarded", requireOpToken("TEST_OP_TOKEN"), (_req, res) => {
    res.json({ ok: true });
  });
  const base = await listen(appFor(principal, guarded));

  delete process.env.TEST_OP_TOKEN;
  const open = await fetch(`${base}/guarded`);
  assert.equal(open.status, 200, "unset env leaves the endpoint open");

  process.env.TEST_OP_TOKEN = "op-secret";
  try {
    const missing = await fetch(`${base}/guarded`);
    assert.equal(missing.status, 401);
    assert.match(
      ((await missing.json()) as { error: string }).error,
      /operational token/,
    );

    const wrong = await fetch(`${base}/guarded`, {
      headers: { "x-op-token": "not-it" },
    });
    assert.equal(wrong.status, 401);

    const viaHeader = await fetch(`${base}/guarded`, {
      headers: { "x-op-token": "op-secret" },
    });
    assert.equal(viaHeader.status, 200, "x-op-token header admits");

    const viaQuery = await fetch(`${base}/guarded?token=op-secret`);
    assert.equal(viaQuery.status, 401, "URL query secrets are rejected");
  } finally {
    delete process.env.TEST_OP_TOKEN;
  }
});

test("/metrics honours METRICS_TOKEN and stays open without it", async () => {
  const base = await listen(appFor(principal, healthRouter));

  process.env.METRICS_TOKEN = "scrape-secret";
  try {
    const denied = await fetch(`${base}/metrics`);
    assert.equal(denied.status, 401);
    const scraped = await fetch(`${base}/metrics`, {
      headers: { "x-op-token": "scrape-secret" },
    });
    assert.equal(scraped.status, 200);
    assert.match(await scraped.text(), /http_request_duration_seconds/);
  } finally {
    delete process.env.METRICS_TOKEN;
  }

  const open = await fetch(`${base}/metrics`);
  assert.equal(open.status, 200, "unset METRICS_TOKEN keeps /metrics open");
});

test("/internal/sweep rejects before running the pass when SWEEP_TOKEN is set", async () => {
  const base = await listen(appFor(principal, sweepRouter));
  delete process.env.SWEEP_TOKEN;
  const dark = await fetch(`${base}/internal/sweep`);
  assert.equal(dark.status, 404, "the mutating sweep is fail-closed");
  process.env.SWEEP_TOKEN = "cron-secret";
  try {
    const denied = await fetch(`${base}/internal/sweep`);
    assert.equal(denied.status, 401);
    const wrongQuery = await fetch(`${base}/internal/sweep?token=nope`);
    assert.equal(wrongQuery.status, 401);
  } finally {
    delete process.env.SWEEP_TOKEN;
  }
});

// ---------------------------------------------------------------------------
// Key rings and the signed path (R100)
// ---------------------------------------------------------------------------

const SECRET_A = "a".repeat(40);
const SECRET_B = "b".repeat(40);

test("parseKeyRing: id:secret entries, unique ids, 32+ character secrets", () => {
  assert.deepEqual(parseKeyRing("X_KEYS", undefined), []);
  assert.deepEqual(parseKeyRing("X_KEYS", "  "), []);
  assert.deepEqual(
    parseKeyRing("X_KEYS", `k1:${SECRET_A}, k2:${SECRET_B}`).map((k) => k.id),
    ["k1", "k2"],
  );
  assert.throws(() => parseKeyRing("X_KEYS", `k1:${SECRET_A},k1:${SECRET_B}`), /unique/);
  assert.throws(() => parseKeyRing("X_KEYS", "k1:short"), /32\+/);
  assert.throws(() => parseKeyRing("X_KEYS", `bad id:${SECRET_A}`), /key-id:secret/);
  assert.throws(() => parseKeyRing("X_KEYS", SECRET_A), /key-id:secret/);
});

test("railKeyRing: the _KEYS ring plus the single _TOKEN as the legacy key; empty means dark", () => {
  delete process.env.RING_TEST_KEYS;
  delete process.env.RING_TEST_TOKEN;
  assert.deepEqual(railKeyRing("RING_TEST_TOKEN"), []);
  process.env.RING_TEST_TOKEN = "single-secret";
  try {
    assert.deepEqual(railKeyRing("RING_TEST_TOKEN"), [
      { id: "legacy", secret: "single-secret", legacy: true },
    ]);
    process.env.RING_TEST_KEYS = `k1:${SECRET_A}`;
    assert.deepEqual(
      railKeyRing("RING_TEST_TOKEN").map((k) => [k.id, k.legacy]),
      [["k1", false], ["legacy", true]],
      "both may be set during a migration",
    );
  } finally {
    delete process.env.RING_TEST_KEYS;
    delete process.env.RING_TEST_TOKEN;
  }
});

function signedRailApp() {
  const guarded: IRouter = Router();
  guarded.post("/hook", requireOpToken("SIGNED_TEST_TOKEN", { required: true }), (req, res) => {
    res.json({ ok: true, echo: req.body });
  });
  guarded.get("/ping", requireOpToken("SIGNED_TEST_TOKEN", { required: true }), (_req, res) => {
    res.json({ ok: true });
  });
  return guarded;
}

test("the signed path: key id + timestamp + HMAC over method, path and the exact body bytes", async () => {
  const base = await listen(appFor(principal, signedRailApp()));
  const key = { id: "k1", secret: SECRET_A };
  process.env.SIGNED_TEST_KEYS = `k1:${SECRET_A},k2:${SECRET_B}`;
  delete process.env.SIGNED_TEST_TOKEN;
  try {
    const body = JSON.stringify({ amount: "10.00", reference: "R-1" });
    const good = await fetch(`${base}/hook`, {
      method: "POST",
      headers: { ...JSON_HEADERS, ...signOpRequest(key, { method: "POST", path: "/hook", body }) },
      body,
    });
    assert.equal(good.status, 200, "a correctly signed request is admitted");

    // The body bytes are covered: the same signature over a different body fails.
    const tampered = await fetch(`${base}/hook`, {
      method: "POST",
      headers: { ...JSON_HEADERS, ...signOpRequest(key, { method: "POST", path: "/hook", body }) },
      body: JSON.stringify({ amount: "10000.00", reference: "R-1" }),
    });
    assert.equal(tampered.status, 401);

    // The path is covered: a signature for one rail does not open another.
    const wrongPath = await fetch(`${base}/hook`, {
      method: "POST",
      headers: { ...JSON_HEADERS, ...signOpRequest(key, { method: "POST", path: "/other", body }) },
      body,
    });
    assert.equal(wrongPath.status, 401);

    // A stale timestamp is outside the replay window; a fresh one is inside it.
    const stale = await fetch(`${base}/hook`, {
      method: "POST",
      headers: {
        ...JSON_HEADERS,
        ...signOpRequest(key, { method: "POST", path: "/hook", body, timestamp: Math.floor(Date.now() / 1000) - 3600 }),
      },
      body,
    });
    assert.equal(stale.status, 401);

    // An unknown key id, and a known id with the wrong secret.
    const unknownKey = await fetch(`${base}/hook`, {
      method: "POST",
      headers: { ...JSON_HEADERS, ...signOpRequest({ id: "k9", secret: SECRET_A }, { method: "POST", path: "/hook", body }) },
      body,
    });
    assert.equal(unknownKey.status, 401);
    const wrongSecret = await fetch(`${base}/hook`, {
      method: "POST",
      headers: { ...JSON_HEADERS, ...signOpRequest({ id: "k1", secret: SECRET_B }, { method: "POST", path: "/hook", body }) },
      body,
    });
    assert.equal(wrongSecret.status, 401);

    // Half a signature is not a legacy token either.
    const partial = await fetch(`${base}/hook`, {
      method: "POST",
      headers: { ...JSON_HEADERS, [OP_KEY_ID_HEADER]: "k1", [OP_TIMESTAMP_HEADER]: String(Math.floor(Date.now() / 1000)) },
      body,
    });
    assert.equal(partial.status, 401);
    assert.ok(OP_SIGNATURE_HEADER.startsWith("x-op-"));

    // A GET signs over the empty body; the second key of the ring works too.
    const ping = await fetch(`${base}/ping`, {
      headers: signOpRequest({ id: "k2", secret: SECRET_B }, { method: "GET", path: "/ping" }),
    });
    assert.equal(ping.status, 200);
  } finally {
    delete process.env.SIGNED_TEST_KEYS;
  }
});

test("dual path: the legacy header matches any ring secret until OP_LEGACY_TOKENS=off; signatures keep working", async () => {
  const base = await listen(appFor(principal, signedRailApp()));
  process.env.SIGNED_TEST_KEYS = `k1:${SECRET_A}`;
  process.env.SIGNED_TEST_TOKEN = "old-single-secret";
  delete process.env.OP_LEGACY_TOKENS;
  try {
    const viaRingSecret = await fetch(`${base}/ping`, { headers: { "x-op-token": SECRET_A } });
    assert.equal(viaRingSecret.status, 200, "a ring key's secret is accepted on the legacy header");
    const viaLegacy = await fetch(`${base}/ping`, { headers: { "x-op-token": "old-single-secret" } });
    assert.equal(viaLegacy.status, 200, "the pre-key-ring single token still works");
    const signedLegacy = await fetch(`${base}/ping`, {
      headers: signOpRequest({ id: "legacy", secret: "old-single-secret" }, { method: "GET", path: "/ping" }),
    });
    assert.equal(signedLegacy.status, 200, "the single token is the `legacy` key on the signed path");

    process.env.OP_LEGACY_TOKENS = "off";
    const refused = await fetch(`${base}/ping`, { headers: { "x-op-token": SECRET_A } });
    assert.equal(refused.status, 401, "the plain header is refused once legacy tokens are off");
    const stillSigned = await fetch(`${base}/ping`, {
      headers: signOpRequest({ id: "k1", secret: SECRET_A }, { method: "GET", path: "/ping" }),
    });
    assert.equal(stillSigned.status, 200);
  } finally {
    delete process.env.SIGNED_TEST_KEYS;
    delete process.env.SIGNED_TEST_TOKEN;
    delete process.env.OP_LEGACY_TOKENS;
  }
});

test("authenticateOpRequest names the key and the path it admitted by", () => {
  const ring = [{ id: "k1", secret: SECRET_A, legacy: false }];
  const headers = signOpRequest(ring[0]!, { method: "GET", path: "/x" });
  const req = {
    method: "GET",
    baseUrl: "",
    path: "/x",
    get: (name: string) => headers[name.toLowerCase()] ?? headers[name],
  } as unknown as Parameters<typeof authenticateOpRequest>[0];
  assert.deepEqual(authenticateOpRequest(req, ring), { ok: true, keyId: "k1", via: "signature" });
  const legacyReq = {
    method: "GET",
    baseUrl: "",
    path: "/x",
    get: (name: string) => (name === "x-op-token" ? SECRET_A : undefined),
  } as unknown as Parameters<typeof authenticateOpRequest>[0];
  assert.deepEqual(authenticateOpRequest(legacyReq, ring), { ok: true, keyId: "k1", via: "token" });
  assert.deepEqual(authenticateOpRequest(legacyReq, []), { ok: false, reason: "rail_dark" });
});
