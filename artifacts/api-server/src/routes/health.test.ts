import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import healthRouter from "./health.ts";
import type { Principal } from "../modules/auth/rbac.ts";
import { appFor, listen, closeAllServers } from "../test-helpers/route-harness.ts";

// Liveness (/healthz), readiness (/readyz — real DB round-trip) and the
// Prometheus scrape endpoint (/metrics). These are public; the harness injects
// a principal the handlers ignore.

const principal: Principal = {
  userId: randomUUID(),
  role: "operator",
  firmId: null,
  clientPartyId: null,
  buyerPartyId: null,
};

after(async () => {
  await closeAllServers();
});

test("/healthz reports ok and the contract version without touching the DB", async () => {
  const base = await listen(appFor(principal, healthRouter));
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { status: string; contractVersion: string };
  assert.equal(body.status, "ok");
  assert.ok(body.contractVersion.length > 0);
});

test("/readyz returns 200 when the database is reachable", async () => {
  const base = await listen(appFor(principal, healthRouter));
  const res = await fetch(`${base}/readyz`);
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { status: string }).status, "ready");
});

test("/metrics serves Prometheus text with the app's series", async () => {
  const base = await listen(appFor(principal, healthRouter));
  const res = await fetch(`${base}/metrics`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/plain/);
  const text = await res.text();
  assert.match(text, /http_request_duration_seconds/);
  assert.match(text, /process_resident_memory_bytes/);
});
