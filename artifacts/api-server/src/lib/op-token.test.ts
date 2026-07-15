import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { opTokenAllows, requireOpToken } from "./op-token.ts";
import healthRouter from "../routes/health.ts";
import sweepRouter from "../routes/sweep.ts";
import type { Principal } from "../modules/auth/rbac.ts";
import {
  appFor,
  listen,
  closeAllServers,
} from "../test-helpers/route-harness.ts";

// The opt-in operational-token guard: unset env keeps an endpoint open
// (existing deployments and the Replit scheduler are unaffected); once set,
// callers must present the secret via the x-op-token header or ?token= query.
// Env mutations here are safe: node:test runs this file in its own process
// and its tests serially.

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

test("requireOpToken: open when unset; header or query admits once set", async () => {
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
    assert.equal(viaQuery.status, 200, "?token= admits URL-only pingers");
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
