import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { applyMigrations, rollbackLast, appliedVersions } from "./index";

// CORE-06: forward migrations must be reversible. This exercises the real DB:
// apply -> assert guardrail objects exist -> roll back -> assert they are gone
// -> re-apply so the environment is left in the migrated state.

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

test("migration 0001 applies and rolls back cleanly", async () => {
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
      (await appliedVersions(pool)).includes(1),
      "version 1 should be tracked after apply",
    );

    const rolled = await rollbackLast(pool);
    assert.equal(rolled, 1, "rollbackLast should return version 1");
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
      (await appliedVersions(pool)).includes(1),
      false,
      "version 1 should no longer be tracked after rollback",
    );

    // Leave the database in the fully-migrated state for the running app.
    await applyMigrations(pool);
    assert.ok(await policyExists(pool, "invoices"));
  } finally {
    await pool.end();
  }
});
