import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import pg from "pg";
import { applyMigrations } from "./index.ts";

// RLS policy-qual pin (refactoring survey item 27). The coverage gate
// (rls-coverage.test.ts) proves every tenant table HAS a policy; nothing
// proved the policies still SAY what they were written to say. A guardrail
// migration that silently weakens a predicate — drops the firm match, joins
// a broader parent, loosens WITH CHECK below USING — ships with every test
// green, because module tests run under exactly the posture the weakened
// policy still allows. This pin freezes every policy's rendered qual (and
// with_check) as a normalized hash: ANY change to any policy expression
// fails here, printing the newly rendered SQL for review.
//
// Changing a policy is legitimate — in a NEW numbered migration, per the
// guardrail discipline. When you do, this test's failure output gives the
// replacement snapshot line to paste after a human has read the rendered
// predicate and agreed it says what the migration claims.
//
// Hashes are over pg_get_expr output normalized to single spaces. That
// rendering is stable for a Postgres major version; CI and the dev scratch
// DB both run Postgres 16 (the version this snapshot was generated on).

const normalized = (s: string): string => s.replace(/\s+/g, " ").trim();
const qualHash = (s: string): string =>
  createHash("sha256").update(normalized(s)).digest("hex").slice(0, 16);

interface PinnedPolicy {
  cmd: string;
  roles: string;
  qual: string; // sha256 prefix of the normalized USING expression
  withCheck: string; // sha256 prefix of the normalized WITH CHECK expression
}

// Generated from the fully migrated scratch DB (see the test body's failure
// output for regeneration lines). Keys are "table/policyname".
const PINNED: Record<string, PinnedPolicy> = {
  "alert_preferences/meridian_tenant_isolation": { cmd: "ALL", roles: "public", qual: "dafdddc785cc1ff9", withCheck: "dafdddc785cc1ff9" },
  "b2c_report_batches/meridian_tenant_isolation": { cmd: "ALL", roles: "public", qual: "5074b35259440c75", withCheck: "5074b35259440c75" },
  "b2c_report_items/meridian_tenant_isolation": { cmd: "ALL", roles: "public", qual: "eabb2d23bb1ce609", withCheck: "eabb2d23bb1ce609" },
  "bank_statement_lines/meridian_tenant_isolation": { cmd: "ALL", roles: "public", qual: "ec22b9149b966688", withCheck: "ec22b9149b966688" },
  "bank_statements/meridian_tenant_isolation": { cmd: "ALL", roles: "public", qual: "5074b35259440c75", withCheck: "5074b35259440c75" },
  "bill_verifications/meridian_clerk_tenant": { cmd: "ALL", roles: "public", qual: "5074b35259440c75", withCheck: "5074b35259440c75" },
  "chase_log/meridian_clerk_tenant": { cmd: "ALL", roles: "public", qual: "5074b35259440c75", withCheck: "5074b35259440c75" },
  "client_compliance_profiles/meridian_tenant_isolation": { cmd: "ALL", roles: "public", qual: "5074b35259440c75", withCheck: "5074b35259440c75" },
  "clerk_action_decisions/meridian_clerk_tenant": { cmd: "ALL", roles: "public", qual: "5074b35259440c75", withCheck: "5074b35259440c75" },
  "clerk_action_policies/meridian_clerk_tenant": { cmd: "ALL", roles: "public", qual: "5074b35259440c75", withCheck: "5074b35259440c75" },
  "clerk_batches/meridian_clerk_tenant": { cmd: "ALL", roles: "public", qual: "5074b35259440c75", withCheck: "5074b35259440c75" },
  "clerk_cases/meridian_clerk_tenant": { cmd: "ALL", roles: "public", qual: "5074b35259440c75", withCheck: "5074b35259440c75" },
  "clerk_plan_policies/meridian_clerk_tenant": { cmd: "ALL", roles: "public", qual: "5074b35259440c75", withCheck: "5074b35259440c75" },
  "clerk_plan_runs/meridian_clerk_tenant": { cmd: "ALL", roles: "public", qual: "5074b35259440c75", withCheck: "5074b35259440c75" },
  "clerk_client_statements/meridian_clerk_tenant": { cmd: "ALL", roles: "public", qual: "5074b35259440c75", withCheck: "5074b35259440c75" },
  "clerk_digests/meridian_clerk_tenant": { cmd: "ALL", roles: "public", qual: "5074b35259440c75", withCheck: "5074b35259440c75" },
  "clerk_eval_fixtures/meridian_bypass_only": { cmd: "ALL", roles: "public", qual: "f4fc01217632ad30", withCheck: "f4fc01217632ad30" },
  "clerk_eval_runs/meridian_bypass_only": { cmd: "ALL", roles: "public", qual: "f4fc01217632ad30", withCheck: "f4fc01217632ad30" },
  "clerk_inference_calls/meridian_clerk_tenant": { cmd: "ALL", roles: "public", qual: "5074b35259440c75", withCheck: "5074b35259440c75" },
  "clerk_intent_eval_runs/meridian_bypass_only": { cmd: "ALL", roles: "public", qual: "f4fc01217632ad30", withCheck: "f4fc01217632ad30" },
  "clerk_intent_fixtures/meridian_bypass_only": { cmd: "ALL", roles: "public", qual: "f4fc01217632ad30", withCheck: "f4fc01217632ad30" },
  "clerk_phrasing_eval_runs/meridian_bypass_only": { cmd: "ALL", roles: "public", qual: "f4fc01217632ad30", withCheck: "f4fc01217632ad30" },
  "clerk_red_team_fixtures/meridian_bypass_only": { cmd: "ALL", roles: "public", qual: "f4fc01217632ad30", withCheck: "f4fc01217632ad30" },
  "collection_accounts/meridian_clerk_tenant": { cmd: "ALL", roles: "public", qual: "5074b35259440c75", withCheck: "5074b35259440c75" },
  "confirmations/meridian_tenant_isolation": { cmd: "ALL", roles: "public", qual: "bc9f8c08010ae3d2", withCheck: "bc9f8c08010ae3d2" },
  "consent_records/meridian_tenant_isolation": { cmd: "ALL", roles: "public", qual: "b1cc10e162986b9e", withCheck: "b1cc10e162986b9e" },
  "cpd_enrollments/meridian_tenant_isolation": { cmd: "ALL", roles: "public", qual: "5074b35259440c75", withCheck: "5074b35259440c75" },
  "deadline_reminder_sends/meridian_tenant_isolation": { cmd: "ALL", roles: "public", qual: "5074b35259440c75", withCheck: "5074b35259440c75" },
  "engagements/meridian_tenant_isolation": { cmd: "ALL", roles: "public", qual: "5074b35259440c75", withCheck: "5074b35259440c75" },
  "erp_connections/meridian_tenant_isolation": { cmd: "ALL", roles: "public", qual: "5074b35259440c75", withCheck: "5074b35259440c75" },
  "erp_sync_runs/meridian_tenant_isolation": { cmd: "ALL", roles: "public", qual: "caff55512b7ef6c1", withCheck: "caff55512b7ef6c1" },
  "escalations/meridian_tenant_isolation": { cmd: "ALL", roles: "public", qual: "5074b35259440c75", withCheck: "5074b35259440c75" },
  "feature_flag_overrides/meridian_tenant_isolation": { cmd: "ALL", roles: "public", qual: "5074b35259440c75", withCheck: "5074b35259440c75" },
  "firm_api_keys/meridian_tenant_isolation": { cmd: "ALL", roles: "public", qual: "5074b35259440c75", withCheck: "5074b35259440c75" },
  "firm_policies/meridian_clerk_tenant": { cmd: "ALL", roles: "public", qual: "5074b35259440c75", withCheck: "5074b35259440c75" },
  "firm_subscriptions/meridian_tenant_isolation": { cmd: "ALL", roles: "public", qual: "5074b35259440c75", withCheck: "5074b35259440c75" },
  "firm_webhook_deliveries/meridian_tenant_isolation": { cmd: "ALL", roles: "public", qual: "5074b35259440c75", withCheck: "5074b35259440c75" },
  "firm_webhooks/meridian_tenant_isolation": { cmd: "ALL", roles: "public", qual: "5074b35259440c75", withCheck: "5074b35259440c75" },
  "filing_reminder_sends/meridian_tenant_isolation": {
    cmd: "ALL",
    roles: "public",
    qual: "5074b35259440c75",
    withCheck: "5074b35259440c75",
  },
  "filing_returns/meridian_tenant_isolation": {
    cmd: "ALL",
    roles: "public",
    qual: "5074b35259440c75",
    withCheck: "5074b35259440c75",
  },
  "firms/meridian_tenant_isolation": { cmd: "ALL", roles: "public", qual: "5bb541f2dec0b54e", withCheck: "5bb541f2dec0b54e" },
  "invitations/meridian_tenant_isolation": { cmd: "ALL", roles: "public", qual: "5074b35259440c75", withCheck: "5074b35259440c75" },
  "invoice_approvals/meridian_clerk_tenant": { cmd: "ALL", roles: "public", qual: "5074b35259440c75", withCheck: "5074b35259440c75" },
  "invoice_lifecycle_events/meridian_tenant_isolation": { cmd: "ALL", roles: "public", qual: "5074b35259440c75", withCheck: "5074b35259440c75" },
  "invoice_lines/meridian_tenant_isolation": { cmd: "ALL", roles: "public", qual: "304b870a9028c9ca", withCheck: "304b870a9028c9ca" },
  "invoices/meridian_tenant_isolation": { cmd: "ALL", roles: "public", qual: "5074b35259440c75", withCheck: "5074b35259440c75" },
  "match_proposals/meridian_tenant_isolation": { cmd: "ALL", roles: "public", qual: "5074b35259440c75", withCheck: "5074b35259440c75" },
  "memberships/meridian_tenant_isolation": { cmd: "ALL", roles: "public", qual: "5074b35259440c75", withCheck: "5074b35259440c75" },
  "obligation_reminder_sends/meridian_tenant_isolation": { cmd: "ALL", roles: "public", qual: "5074b35259440c75", withCheck: "5074b35259440c75" },
  "obligations/meridian_tenant_isolation": { cmd: "ALL", roles: "public", qual: "5074b35259440c75", withCheck: "5074b35259440c75" },
  "onboarding_prospects/meridian_tenant_isolation": { cmd: "ALL", roles: "public", qual: "5074b35259440c75", withCheck: "5074b35259440c75" },
  "operator_cases/meridian_tenant_isolation": { cmd: "ALL", roles: "public", qual: "5074b35259440c75", withCheck: "5074b35259440c75" },
  "party_name_aliases/meridian_clerk_tenant": { cmd: "ALL", roles: "public", qual: "5074b35259440c75", withCheck: "5074b35259440c75" },
  "password_resets/meridian_bypass_only": { cmd: "ALL", roles: "public", qual: "f4fc01217632ad30", withCheck: "f4fc01217632ad30" },
  "payment_intents/meridian_tenant_isolation": { cmd: "ALL", roles: "public", qual: "5074b35259440c75", withCheck: "5074b35259440c75" },
  "push_devices/meridian_tenant_isolation": { cmd: "ALL", roles: "public", qual: "95e6dfb4632dcbde", withCheck: "95e6dfb4632dcbde" },
  "recurring_invoice_templates/meridian_tenant_isolation": { cmd: "ALL", roles: "public", qual: "5074b35259440c75", withCheck: "5074b35259440c75" },
  "revenue_share_statements/meridian_tenant_isolation": { cmd: "ALL", roles: "public", qual: "5074b35259440c75", withCheck: "5074b35259440c75" },
  "settlement_events/meridian_tenant_isolation": { cmd: "ALL", roles: "public", qual: "6f28834ac4127d84", withCheck: "6f28834ac4127d84" },
  "staff_notification_preferences/meridian_tenant_isolation": { cmd: "ALL", roles: "public", qual: "5074b35259440c75", withCheck: "5074b35259440c75" },
  "stamp_records/meridian_tenant_isolation": { cmd: "ALL", roles: "public", qual: "11ed828f35ee7357", withCheck: "11ed828f35ee7357" },
  "statement_connections/meridian_tenant_isolation": { cmd: "ALL", roles: "public", qual: "5074b35259440c75", withCheck: "5074b35259440c75" },
  "statement_sync_runs/meridian_tenant_isolation": { cmd: "ALL", roles: "public", qual: "5074b35259440c75", withCheck: "5074b35259440c75" },
  "submission_attempts/meridian_tenant_isolation": { cmd: "ALL", roles: "public", qual: "06c8692ee8d2489d", withCheck: "06c8692ee8d2489d" },
  "wht_credits/meridian_tenant_isolation": { cmd: "ALL", roles: "public", qual: "5074b35259440c75", withCheck: "5074b35259440c75" },
  "wht_reminder_sends/meridian_tenant_isolation": { cmd: "ALL", roles: "public", qual: "5074b35259440c75", withCheck: "5074b35259440c75" },};

test("every RLS policy's rendered qual matches its pinned hash", async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set to run migration tests");
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await applyMigrations(pool);
    const { rows } = await pool.query<{
      tablename: string;
      policyname: string;
      cmd: string;
      roles: string;
      qual: string | null;
      with_check: string | null;
    }>(
      `SELECT tablename, policyname, cmd,
              array_to_string(roles, ',') AS roles,
              qual, with_check
       FROM pg_policies WHERE schemaname = 'public'
       ORDER BY tablename, policyname`,
    );
    assert.ok(rows.length > 0, "pg_policies enumeration found policies");

    const live = new Map(
      rows.map((r) => [`${r.tablename}/${r.policyname}`, r]),
    );

    // Exact inventory: a dropped or renamed policy is a guardrail change and
    // must update this pin deliberately.
    assert.deepEqual(
      [...live.keys()].sort(),
      Object.keys(PINNED).sort(),
      "the set of RLS policies changed — add/remove the matching PINNED entries (failure output above names the difference)",
    );

    for (const [key, pin] of Object.entries(PINNED)) {
      const row = live.get(key)!;
      const renderLine = `  "${key}": { cmd: "${row.cmd}", roles: "${row.roles}", qual: "${qualHash(row.qual ?? "")}", withCheck: "${qualHash(row.with_check ?? "")}" },`;
      assert.equal(
        row.cmd,
        pin.cmd,
        `${key}: policy command changed (${pin.cmd} -> ${row.cmd})`,
      );
      assert.equal(
        row.roles,
        pin.roles,
        `${key}: policy roles changed (${pin.roles} -> ${row.roles})`,
      );
      assert.equal(
        qualHash(row.qual ?? ""),
        pin.qual,
        `${key}: the USING expression changed. Rendered qual now:\n` +
          `${normalized(row.qual ?? "")}\n` +
          `If a new migration deliberately made this change and a human has ` +
          `read the predicate above, replace the PINNED line with:\n${renderLine}`,
      );
      assert.equal(
        qualHash(row.with_check ?? ""),
        pin.withCheck,
        `${key}: the WITH CHECK expression changed. Rendered with_check now:\n` +
          `${normalized(row.with_check ?? "")}\n` +
          `If deliberate and reviewed, replace the PINNED line with:\n${renderLine}`,
      );
    }

    // Hash-independent net (survives careless snapshot regeneration): every
    // policy must carry the app.bypass escape — operators, workers and
    // NO_CONTEXT bypass stages all depend on it; a policy without it bricks
    // every cross-tenant path on that table.
    for (const [key, row] of live) {
      assert.ok(
        (row.qual ?? "").includes("app.bypass"),
        `${key}: the USING expression lost the app.bypass escape — no ` +
          `cross-tenant context (operator routes, worker, bypass stages) ` +
          `could touch this table`,
      );
    }

    // Enabled-state net (round-27 review MAJOR): pg_policies keeps listing a
    // table's policies after ALTER TABLE ... DISABLE ROW LEVEL SECURITY, and
    // the coverage gate only enumerates tenant-KEYED tables — so a
    // policy-bearing table WITHOUT a tenant-key column (password_resets, the
    // eval stores) could have RLS switched off with every DB gate green,
    // its policies reduced to decoration. Every pinned table must have row
    // security enabled AND forced — the guardrail migrations set both.
    const pinnedTables = [
      ...new Set(Object.keys(PINNED).map((k) => k.split("/")[0])),
    ];
    const { rows: states } = await pool.query<{
      relname: string;
      rls_enabled: boolean;
      rls_forced: boolean;
    }>(
      `SELECT c.relname,
              c.relrowsecurity AS rls_enabled,
              c.relforcerowsecurity AS rls_forced
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
       WHERE c.relname = ANY($1)`,
      [pinnedTables],
    );
    const stateByTable = new Map(states.map((s) => [s.relname, s]));
    for (const table of pinnedTables) {
      const state = stateByTable.get(table);
      assert.ok(state, `pinned table '${table}' no longer exists`);
      assert.ok(
        state.rls_enabled && state.rls_forced,
        `${table}: row security is not enabled+forced — its pinned policies ` +
          `are decoration (DISABLE ROW LEVEL SECURITY leaves pg_policies ` +
          `intact, and the coverage gate cannot see non-tenant-keyed tables)`,
      );
    }
  } finally {
    await pool.end();
  }
});
