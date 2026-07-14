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

// 0005's Clerk tables are bypass-only (operators/auditors), not firm-keyed.
async function bypassPolicyExists(
  pool: pg.Pool,
  table: string,
): Promise<boolean> {
  const res = await pool.query(
    "SELECT 1 FROM pg_policies WHERE tablename = $1 AND policyname = 'meridian_bypass_only' LIMIT 1",
    [table],
  );
  return res.rowCount! > 0;
}

// 0009 widens the Clerk tables to firm-keyed-or-bypass for client capture.
async function clerkTenantPolicyExists(
  pool: pg.Pool,
  table: string,
): Promise<boolean> {
  const res = await pool.query(
    "SELECT 1 FROM pg_policies WHERE tablename = $1 AND policyname = 'meridian_clerk_tenant' LIMIT 1",
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
    // 0009 supersedes 0005's bypass-only policy on the two client-facing
    // Clerk tables; the eval tables stay bypass-only.
    assert.ok(
      await clerkTenantPolicyExists(pool, "clerk_cases"),
      "Clerk tenant policy on clerk_cases should exist after apply",
    );
    assert.ok(
      await clerkTenantPolicyExists(pool, "clerk_inference_calls"),
      "Clerk tenant policy on clerk_inference_calls should exist after apply",
    );
    assert.equal(
      await bypassPolicyExists(pool, "clerk_cases"),
      false,
      "bypass-only policy on clerk_cases is replaced by 0009",
    );
    assert.ok(
      await bypassPolicyExists(pool, "clerk_eval_runs"),
      "Clerk bypass-only policy on clerk_eval_runs should exist after apply",
    );
    assert.ok(
      await policyExists(pool, "recurring_invoice_templates"),
      "RLS policy on recurring_invoice_templates should exist after apply",
    );
    assert.ok(
      await policyExists(pool, "deadline_reminder_sends"),
      "RLS policy on deadline_reminder_sends should exist after apply",
    );
    assert.ok(
      await policyExists(pool, "invitations"),
      "RLS policy on invitations should exist after apply",
    );
    assert.ok(
      await bypassPolicyExists(pool, "clerk_eval_fixtures"),
      "bypass-only policy on clerk_eval_fixtures should exist after apply",
    );
    assert.ok(
      await clerkTenantPolicyExists(pool, "clerk_digests"),
      "Clerk tenant policy on clerk_digests should exist after apply",
    );
    const versions = await appliedVersions(pool);
    for (let v = 1; v <= 11; v++) {
      assert.ok(versions.includes(v), `version ${v} should be tracked after apply`);
    }

    // Roll back newest first: 0011 (digest guardrails)...
    const rolled11 = await rollbackLast(pool);
    assert.equal(rolled11, 11, "first rollback should be version 11");
    assert.equal(
      await clerkTenantPolicyExists(pool, "clerk_digests"),
      false,
      "digest policy should be gone after rolling back 0011",
    );
    assert.ok(
      await bypassPolicyExists(pool, "clerk_eval_fixtures"),
      "0010 policy must survive the 0011 rollback",
    );

    // ...then 0010 (eval fixture guardrails)...
    const rolled10 = await rollbackLast(pool);
    assert.equal(rolled10, 10, "second rollback should be version 10");
    assert.equal(
      await bypassPolicyExists(pool, "clerk_eval_fixtures"),
      false,
      "eval-fixture policy should be gone after rolling back 0010",
    );
    assert.ok(
      await clerkTenantPolicyExists(pool, "clerk_cases"),
      "0009 policy must survive the 0010 rollback",
    );

    // ...then 0009 (clerk tenant read)...
    const rolled9 = await rollbackLast(pool);
    assert.equal(rolled9, 9, "third rollback should be version 9");
    assert.equal(
      await clerkTenantPolicyExists(pool, "clerk_cases"),
      false,
      "clerk tenant policy should be gone after rolling back 0009",
    );
    assert.ok(
      await bypassPolicyExists(pool, "clerk_cases"),
      "0005's bypass-only policy is restored by the 0009 rollback",
    );
    assert.ok(
      await policyExists(pool, "invitations"),
      "0008 policy must survive the 0009 rollback",
    );

    // ...then 0008 (invitation guardrails)...
    const rolled8 = await rollbackLast(pool);
    assert.equal(rolled8, 8, "fourth rollback should be version 8");
    assert.equal(
      await policyExists(pool, "invitations"),
      false,
      "invitations RLS policy should be gone after rolling back 0008",
    );
    assert.ok(
      await policyExists(pool, "recurring_invoice_templates"),
      "0007 policy must survive the 0008 rollback",
    );

    // ...then 0007 (recurring/reminder guardrails)...
    const rolled7 = await rollbackLast(pool);
    assert.equal(rolled7, 7, "fifth rollback should be version 7");
    assert.equal(
      await policyExists(pool, "recurring_invoice_templates"),
      false,
      "recurring RLS policy should be gone after rolling back 0007",
    );
    assert.equal(
      await policyExists(pool, "deadline_reminder_sends"),
      false,
      "reminder RLS policy should be gone after rolling back 0007",
    );
    assert.ok(
      await bypassPolicyExists(pool, "clerk_eval_runs"),
      "0006 Clerk eval policy must survive the 0007 rollback",
    );

    // ...then 0006 (Clerk eval guardrails)...
    const rolled6 = await rollbackLast(pool);
    assert.equal(rolled6, 6, "sixth rollback should be version 6");
    assert.equal(
      await bypassPolicyExists(pool, "clerk_eval_runs"),
      false,
      "eval bypass-only policy should be gone after rolling back 0006",
    );
    assert.ok(
      await bypassPolicyExists(pool, "clerk_cases"),
      "0005 Clerk policy must survive the 0006 rollback",
    );

    // ...then 0005 (Clerk guardrails)...
    const rolled5 = await rollbackLast(pool);
    assert.equal(rolled5, 5, "seventh rollback should be version 5");
    assert.equal(
      await bypassPolicyExists(pool, "clerk_cases"),
      false,
      "Clerk bypass-only policy should be gone after rolling back 0005",
    );
    assert.ok(
      await lineTriggerAllowsFailed(pool),
      "0004 trigger variant must survive the 0005 rollback",
    );

    // ...then 0004 (fix-retry mutability)...
    const rolled4 = await rollbackLast(pool);
    assert.equal(rolled4, 4, "eighth rollback should be version 4");
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
    assert.equal(rolled3, 3, "ninth rollback should be version 3");
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
    assert.equal(rolled2, 2, "tenth rollback should be version 2");
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
    assert.equal(rolled1, 1, "eleventh rollback should be version 1");
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
    assert.ok(await clerkTenantPolicyExists(pool, "clerk_cases"));
    assert.ok(await bypassPolicyExists(pool, "clerk_eval_runs"));
    assert.ok(await bypassPolicyExists(pool, "clerk_eval_fixtures"));
    assert.ok(await clerkTenantPolicyExists(pool, "clerk_digests"));
    assert.ok(await policyExists(pool, "recurring_invoice_templates"));
    assert.ok(await policyExists(pool, "invitations"));
  } finally {
    await pool.end();
  }
});
