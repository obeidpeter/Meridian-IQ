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

// 0004 widens the mutable-status window of the immutability triggers from
// draft-only to draft/validated/failed; detect which variant is installed by
// inspecting the function body.
async function lineTriggerAllowsFailed(pool: pg.Pool): Promise<boolean> {
  const res = await pool.query(
    `SELECT prosrc FROM pg_proc WHERE proname = 'meridian_enforce_line_immutability' LIMIT 1`,
  );
  const src: string | undefined = res.rows[0]?.prosrc;
  return src !== undefined && src.includes("'failed'");
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
    assert.ok(
      await policyExists(pool, "push_devices"),
      "push RLS policy on push_devices should exist after apply",
    );
    assert.ok(
      await lineTriggerAllowsFailed(pool),
      "line immutability trigger should allow failed-status edits after apply",
    );
    const versions = await appliedVersions(pool);
    assert.ok(versions.includes(1), "version 1 should be tracked after apply");
    assert.ok(versions.includes(2), "version 2 should be tracked after apply");
    assert.ok(versions.includes(3), "version 3 should be tracked after apply");
    assert.ok(versions.includes(4), "version 4 should be tracked after apply");

    // Roll back newest first: 0004 (fix-retry mutability)...
    const rolled4 = await rollbackLast(pool);
    assert.equal(rolled4, 4, "first rollback should be version 4");
    assert.equal(
      await lineTriggerAllowsFailed(pool),
      false,
      "line immutability trigger should be draft-only after rolling back 0004",
    );
    assert.ok(
      await policyExists(pool, "push_devices"),
      "push RLS policy must survive the 0004 rollback",
    );

    // ...then 0003 (push guardrails)...
    const rolled3 = await rollbackLast(pool);
    assert.equal(rolled3, 3, "second rollback should be version 3");
    assert.equal(
      await policyExists(pool, "push_devices"),
      false,
      "push RLS policy should be gone after rolling back 0003",
    );
    assert.ok(
      await policyExists(pool, "bank_statements"),
      "R2 RLS policy must survive the 0003 rollback",
    );

    // ...then 0002 (R2 guardrails)...
    const rolled2 = await rollbackLast(pool);
    assert.equal(rolled2, 2, "third rollback should be version 2");
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
    assert.equal(rolled1, 1, "fourth rollback should be version 1");
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
    assert.ok(await policyExists(pool, "push_devices"));
  } finally {
    await pool.end();
  }
});
