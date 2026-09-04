import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { connectionConfig } from "./connection-config.ts";

test("PostgreSQL cancels actual statements and lock waits; pooled sessions remain reusable", async () => {
  assert.ok(
    process.env.DATABASE_URL,
    "Run this integration test with a disposable PostgreSQL DATABASE_URL",
  );
  const pool = new pg.Pool(
    connectionConfig({
      ...process.env,
      PG_STATEMENT_TIMEOUT_MS: "500",
      PG_LOCK_TIMEOUT_MS: "100",
    }),
  );
  const blocker = await pool.connect();
  const waiter = await pool.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock(198005312)");
    await waiter.query("BEGIN");
    const started = Date.now();
    await assert.rejects(
      waiter.query("SELECT pg_advisory_xact_lock(198005312)"),
      { code: "55P03" },
    );
    assert.ok(Date.now() - started < 2_000);
    await waiter.query("ROLLBACK");
    await assert.rejects(waiter.query("SELECT pg_sleep(10)"), {
      code: "57014",
    });
    assert.equal((await waiter.query("SELECT 1 AS alive")).rows[0].alive, 1);
    const sessions = await blocker.query(
      "SELECT state, wait_event FROM pg_stat_activity WHERE pid = $1",
      [(waiter as pg.PoolClient & { processID: number }).processID],
    );
    assert.equal(sessions.rows[0].state, "idle");
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
    waiter.release();
    await pool.end();
  }
});
