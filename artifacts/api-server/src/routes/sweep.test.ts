import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import express from "express";
import {
  getDb,
  pool,
  workerLockPool,
  runHttpDatabaseBoundary,
  finishHttpAuthentication,
} from "@workspace/db";
import router from "./sweep.ts";
import { errorHandler } from "../middleware/error.ts";
import { listen, closeAllServers } from "../test-helpers/route-harness.ts";
import {
  listSweeps,
  unregisterSweep,
  registerSweep,
  awaitWorkerIdle,
  resumeWorker,
} from "../modules/pipeline/pipeline.ts";

test("HTTP sweep outcomes preserve failure evidence, ownership, authorization and database boundaries", async (t) => {
  const previousToken = process.env.SWEEP_TOKEN;
  const previousLimit = process.env.SWEEP_RATE_LIMIT_PER_MIN;
  const token = randomUUID();
  process.env.SWEEP_TOKEN = token;
  delete process.env.SWEEP_RATE_LIMIT_PER_MIN;
  for (const sweep of listSweeps()) unregisterSweep(sweep.name);
  resumeWorker();
  let succeeded = 0,
    failed = 0,
    healthy = 0,
    rollbacks = 0;
  let claimFailure = false,
    reconcileFailure = false,
    rateCount = 1;
  const held = new Set<number>();
  t.mock.method(pool, "connect", async () =>
    Object.assign(new EventEmitter(), {
      query: async (config: string | { text: string }) => {
        const text = typeof config === "string" ? config : config.text;
        if (
          text.includes("operational_heartbeats") &&
          text.includes("last_succeeded_at")
        )
          succeeded++;
        if (
          text.includes("operational_heartbeats") &&
          text.includes("last_failed_at")
        )
          failed++;
        if (text === "ROLLBACK") rollbacks++;
        if (claimFailure && text.startsWith('update "outbox_events"'))
          throw new Error("fixture claim failure");
        return { rows: [], rowCount: 0, fields: [] };
      },
      release: () => {},
    }),
  );
  t.mock.method(pool, "query", async (text: string) => {
    assert.ok(text.includes("INSERT INTO login_attempts"));
    return {
      rows: [{ count: rateCount, window_start: new Date() }],
      rowCount: 1,
    };
  });
  t.mock.method(workerLockPool, "connect", async () =>
    Object.assign(new EventEmitter(), {
      query: async (text: string, [lock]: [number]) => {
        if (reconcileFailure && lock === 991103)
          throw new Error("fixture lock failure");
        if (text.includes("pg_try_advisory_lock")) {
          const acquired = !held.has(lock);
          if (acquired) held.add(lock);
          return { rows: [{ acquired }] };
        }
        return { rows: [{ unlocked: held.delete(lock) }] };
      },
      release: () => {},
    }),
  );
  registerSweep("test.http-boundary", async () => {
    assert.throws(() => getDb(), /explicit database context/);
    healthy++;
  });
  const app = express();
  app.use((req, _res, next) =>
    runHttpDatabaseBoundary(() => {
      finishHttpAuthentication();
      req.id = randomUUID();
      req.log = {
        info() {},
        warn() {},
        error() {},
      } as unknown as typeof req.log;
      next();
    }),
  );
  app.use(router);
  app.use(errorHandler);
  const base = await listen(app);
  const request = () =>
    fetch(`${base}/internal/sweep`, { headers: { "x-op-token": token } });
  let finish: (() => void) | undefined;
  try {
    assert.equal((await fetch(`${base}/internal/sweep`)).status, 401);
    assert.equal(healthy, 0);
    const ok = await request();
    assert.equal(ok.status, 200);
    assert.equal(succeeded, 1);
    registerSweep("test.failure", async () => {
      throw new Error("private fixture detail");
    });
    const partial = await request();
    assert.equal(partial.status, 503);
    assert.equal(partial.headers.get("retry-after"), "60");
    const partialText = await partial.text();
    assert.equal(JSON.parse(partialText).failed.sweeps, 1);
    assert.ok(!partialText.includes("private fixture detail"));
    assert.equal(healthy, 2);
    assert.equal(succeeded, 1);
    assert.equal(failed, 1);
    unregisterSweep("test.failure");
    await awaitWorkerIdle(1_000);

    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    registerSweep("test.timeout", () => blocked, { timeoutMs: 10 });
    assert.equal((await request()).status, 503);
    assert.equal(held.has(991102), true, "timeout keeps distributed ownership");
    const busy = await request();
    assert.equal(busy.status, 202);
    assert.equal(JSON.parse(await busy.text()).ran.sweeps, false);
    assert.equal(succeeded, 1, "busy never clears failure evidence");
    assert.ok(finish);
    finish();
    assert.equal(await awaitWorkerIdle(1_000), true);
    unregisterSweep("test.timeout");

    claimFailure = true;
    const drain = await request();
    assert.equal(drain.status, 503);
    assert.equal(JSON.parse(await drain.text()).failed.drain, true);
    assert.ok(rollbacks > 0);
    claimFailure = false;
    reconcileFailure = true;
    const reconcile = await request();
    assert.equal(reconcile.status, 503);
    assert.equal(JSON.parse(await reconcile.text()).failed.reconcile, true);
    reconcileFailure = false;
    rateCount = 13;
    const beforeRate = healthy;
    const limited = await request();
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "60");
    assert.equal(healthy, beforeRate);
    rateCount = 1;
    assert.equal(
      (await request()).status,
      200,
      "recovery runs without restarting the worker",
    );
    assert.equal(succeeded, 2);
  } finally {
    finish?.();
    await awaitWorkerIdle(1_000);
    await closeAllServers();
    for (const sweep of listSweeps()) unregisterSweep(sweep.name);
    if (previousToken === undefined) delete process.env.SWEEP_TOKEN;
    else process.env.SWEEP_TOKEN = previousToken;
    if (previousLimit === undefined)
      delete process.env.SWEEP_RATE_LIMIT_PER_MIN;
    else process.env.SWEEP_RATE_LIMIT_PER_MIN = previousLimit;
  }
});
