import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { applyMigrations, rollbackLast, appliedVersions } from "./index.ts";

// CORE-06: forward migrations must be reversible. This exercises the real DB:
// apply -> assert guardrail objects exist -> roll back (newest first) -> assert
// they are gone -> re-apply so the environment is left in the migrated state.

function makePool(): pg.Pool {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set to run migration tests");
  }
  return new pg.Pool({ connectionString: process.env.DATABASE_URL });
}

async function functionExists(pool: pg.Pool, name: string): Promise<boolean> {
  const res = await pool.query(
    "SELECT 1 FROM pg_proc WHERE proname = $1 LIMIT 1",
    [name],
  );
  return res.rowCount! > 0;
}

async function policyExists(pool: pg.Pool, table: string): Promise<boolean> {
  const res = await pool.query(
    "SELECT 1 FROM pg_policies WHERE tablename = $1 AND policyname = 'meridian_tenant_isolation' LIMIT 1",
    [table],
  );
  return res.rowCount! > 0;
}

test("migrations apply and roll back cleanly in reverse order", async () => {
  const pool = makePool();
  try {
    await applyMigrations(pool);
    assert.ok(
      await functionExists(pool, "meridian_block_mutations"),
      "append-only function should exist after apply",
    );
    assert.ok(
      await functionExists(pool, "meridian_purge_expired"),
      "purge function should exist after apply",
    );
    assert.ok(
      await policyExists(pool, "invoices"),
      "RLS policy on invoices should exist after apply",
    );
    assert.ok(
      await policyExists(pool, "bank_statements"),
      "R2 RLS policy on bank_statements should exist after apply",
    );
    assert.ok(
      await policyExists(pool, "b2c_report_batches"),
      "R2 RLS policy on b2c_report_batches should exist after apply",
    );
    const versions = await appliedVersions(pool);
    assert.ok(versions.includes(1), "version 1 should be tracked after apply");
    assert.ok(versions.includes(2), "version 2 should be tracked after apply");

    // Roll back newest first: 0002 (R2 guardrails)...
    const rolled2 = await rollbackLast(pool);
    assert.equal(rolled2, 2, "first rollback should be version 2");
    assert.equal(
      await policyExists(pool, "bank_statements"),
      false,
      "R2 RLS policy should be gone after rolling back 0002",
    );
    assert.ok(
      await policyExists(pool, "invoices"),
      "base RLS policy must survive the 0002 rollback",
    );

    // ...then 0001 (base guardrails).
    const rolled1 = await rollbackLast(pool);
    assert.equal(rolled1, 1, "second rollback should be version 1");
    assert.equal(
      await functionExists(pool, "meridian_block_mutations"),
      false,
      "append-only function should be gone after rollback",
    );
    assert.equal(
      await policyExists(pool, "invoices"),
      false,
      "RLS policy should be gone after rollback",
    );
    assert.equal(
      (await appliedVersions(pool)).length,
      0,
      "no versions should be tracked after full rollback",
    );

    // Leave the database in the fully-migrated state for the running app.
    await applyMigrations(pool);
    assert.ok(await policyExists(pool, "invoices"));
    assert.ok(await policyExists(pool, "bank_statements"));
  } finally {
    await pool.end();
  }
});
