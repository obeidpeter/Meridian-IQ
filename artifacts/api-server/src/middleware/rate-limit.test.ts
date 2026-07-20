import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import { pool } from "@workspace/db";
import { rateLimit } from "./rate-limit.ts";
import { errorHandler } from "./error.ts";
import type { Principal } from "../modules/auth/rbac.ts";
import { listen, closeAllServers } from "../test-helpers/route-harness.ts";

// Per-principal rate limiting: fixed-window counters in login_attempts on the
// RAW pool (visible outside any request transaction — the property that makes
// a 429's own rollback unable to erase the count), two independent classes
// (GENERAL and MODEL), public-path exemption, env tunability, and 429 +
// Retry-After semantics.

const ENV_KEYS = ["RATE_LIMIT_GENERAL_PER_MIN", "RATE_LIMIT_MODEL_PER_MIN"];
const savedEnv: Record<string, string | undefined> = {};

before(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
});

after(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await closeAllServers();
});

// Wired exactly as app.ts does: principal already resolved, then the limiter,
// then routes. Each test uses a fresh userId so counters never interfere.
function limitedApp(userId: string) {
  const app = express();
  app.use((req, _res, next) => {
    req.principal = {
      userId,
      role: "firm_staff",
      firmId: null,
      clientPartyId: null,
      buyerPartyId: null,
    } satisfies Principal;
    req.log = {
      warn: () => {},
      error: () => {},
      info: () => {},
    } as unknown as typeof req.log;
    next();
  });
  app.use(rateLimit);
  app.all("*path", (req, res) => {
    // A 4xx handler outcome must not undo the count (raw-pool property).
    if (req.path.endsWith("/fails")) {
      res.status(400).json({ error: "handler failure" });
      return;
    }
    res.json({ ok: true });
  });
  app.use(errorHandler);
  return app;
}

async function counterFor(key: string): Promise<number | null> {
  const { rows } = await pool.query<{ count: number }>(
    "SELECT count FROM login_attempts WHERE key = $1",
    [key],
  );
  return rows.length ? Number(rows[0].count) : null;
}

test("general class: N requests pass, the N+1th is 429 with Retry-After; counts persist on the raw pool", async () => {
  process.env.RATE_LIMIT_GENERAL_PER_MIN = "3";
  process.env.RATE_LIMIT_MODEL_PER_MIN = "1000";
  const userId = randomUUID();
  const base = await listen(limitedApp(userId));

  for (let i = 0; i < 3; i++) {
    const res = await fetch(`${base}/api/anything`);
    assert.equal(res.status, 200, `request ${i + 1} inside the window passes`);
  }
  const limited = await fetch(`${base}/api/anything`);
  assert.equal(limited.status, 429);
  const retryAfter = Number(limited.headers.get("retry-after"));
  assert.ok(retryAfter >= 1 && retryAfter <= 60, "Retry-After points at the window end");
  const body = (await limited.json()) as { error: string };
  assert.match(body.error, /Too many requests/);

  // The counter lives in login_attempts under the namespaced key, written on
  // the raw pool — the 429th request itself is counted.
  assert.equal(await counterFor(`rl:g:${userId}`), 4);
});

test("a request whose handler 4xxs still counts (bump happens before any transaction)", async () => {
  process.env.RATE_LIMIT_GENERAL_PER_MIN = "100";
  process.env.RATE_LIMIT_MODEL_PER_MIN = "1000";
  const userId = randomUUID();
  const base = await listen(limitedApp(userId));

  const res = await fetch(`${base}/api/thing/fails`);
  assert.equal(res.status, 400);
  assert.equal(
    await counterFor(`rl:g:${userId}`),
    1,
    "the failed request's count survives — same raw-pool posture as the login throttle",
  );
});

test("model class is independent: model routes hit their own tighter cap while general traffic still flows", async () => {
  process.env.RATE_LIMIT_GENERAL_PER_MIN = "100";
  process.env.RATE_LIMIT_MODEL_PER_MIN = "2";
  const userId = randomUUID();
  const base = await listen(limitedApp(userId));

  const modelReq = () =>
    fetch(`${base}/api/clerk/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  assert.equal((await modelReq()).status, 200);
  assert.equal((await modelReq()).status, 200);
  const limited = await modelReq();
  assert.equal(limited.status, 429, "third model call exceeds MODEL=2");
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);

  // Both counters advanced for the model route; general is nowhere near cap.
  assert.equal(await counterFor(`rl:m:${userId}`), 3);
  assert.equal(await counterFor(`rl:g:${userId}`), 3);

  // Ordinary traffic is untouched by the exhausted model class.
  const general = await fetch(`${base}/api/invoices`);
  assert.equal(general.status, 200);

  // A GET on a path that only rate-limits POST is not a model route.
  const getAsk = await fetch(`${base}/api/clerk/ask`);
  assert.equal(getAsk.status, 200, "method-scoped: GET /clerk/ask is general only");
  assert.equal(await counterFor(`rl:m:${userId}`), 3, "model counter untouched by GET");
});

test("parameterized model routes match by pattern (case retry, narrative, reply-draft)", async () => {
  process.env.RATE_LIMIT_GENERAL_PER_MIN = "100";
  process.env.RATE_LIMIT_MODEL_PER_MIN = "100";
  const userId = randomUUID();
  const base = await listen(limitedApp(userId));

  for (const path of [
    `/api/clerk/cases/${randomUUID()}/retry`,
    `/api/engagements/${randomUUID()}/narrative`,
    `/api/escalations/${randomUUID()}/reply-draft`,
  ]) {
    const res = await fetch(`${base}${path}`, { method: "POST" });
    assert.equal(res.status, 200);
  }
  assert.equal(
    await counterFor(`rl:m:${userId}`),
    3,
    "all three :id-segment model routes counted in the MODEL class",
  );
});

test("public paths are exempt: no 429 and no counter row", async () => {
  process.env.RATE_LIMIT_GENERAL_PER_MIN = "2";
  process.env.RATE_LIMIT_MODEL_PER_MIN = "2";
  const userId = randomUUID();
  const base = await listen(limitedApp(userId));

  for (let i = 0; i < 5; i++) {
    const res = await fetch(`${base}/api/healthz`);
    assert.equal(res.status, 200, "public path never limited");
  }
  const login = await fetch(`${base}/api/auth/login`, { method: "POST" });
  assert.equal(login.status, 200, "login keeps its own throttle, not this one");
  assert.equal(await counterFor(`rl:g:${userId}`), null, "no counter written");
});

test("a class set to 0 is disabled: unlimited and unbumped", async () => {
  process.env.RATE_LIMIT_GENERAL_PER_MIN = "0";
  process.env.RATE_LIMIT_MODEL_PER_MIN = "0";
  const userId = randomUUID();
  const base = await listen(limitedApp(userId));

  for (let i = 0; i < 6; i++) {
    const res = await fetch(`${base}/api/clerk/ask`, { method: "POST" });
    assert.equal(res.status, 200);
  }
  assert.equal(await counterFor(`rl:g:${userId}`), null);
  assert.equal(await counterFor(`rl:m:${userId}`), null);
});

test("unset env falls back to the generous defaults (600 general / 60 model)", async () => {
  delete process.env.RATE_LIMIT_GENERAL_PER_MIN;
  delete process.env.RATE_LIMIT_MODEL_PER_MIN;
  const userId = randomUUID();
  const base = await listen(limitedApp(userId));

  // A burst far beyond any journey's per-minute chatter sails through.
  for (let i = 0; i < 30; i++) {
    const res = await fetch(`${base}/api/invoices`);
    assert.equal(res.status, 200);
  }
  assert.equal(await counterFor(`rl:g:${userId}`), 30);
});

test("the fixed window resets: an expired window starts a fresh count", async () => {
  process.env.RATE_LIMIT_GENERAL_PER_MIN = "2";
  process.env.RATE_LIMIT_MODEL_PER_MIN = "1000";
  const userId = randomUUID();
  const base = await listen(limitedApp(userId));

  assert.equal((await fetch(`${base}/api/x`)).status, 200);
  assert.equal((await fetch(`${base}/api/x`)).status, 200);
  assert.equal((await fetch(`${base}/api/x`)).status, 429);

  // Age the window past 60s directly (the bump's CASE arm resets it).
  await pool.query(
    "UPDATE login_attempts SET window_start = now() - interval '61 seconds' WHERE key = $1",
    [`rl:g:${userId}`],
  );
  const fresh = await fetch(`${base}/api/x`);
  assert.equal(fresh.status, 200, "expired window resets to a fresh count");
  assert.equal(await counterFor(`rl:g:${userId}`), 1);
});
