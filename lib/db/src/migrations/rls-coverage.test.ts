import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { applyMigrations } from "./index.ts";

// RLS coverage gate (SEC-02). Tables come from `drizzle push`, policies from
// the numbered guardrail migrations — and 0001's default privileges grant
// meridian_app full DML on every table, so a tenant table added WITHOUT a
// policy migration is cross-tenant readable by default, protected only by
// route-guard discipline. That drift class happened repeatedly (0005's own
// header admits it; the architecture review found nine instances closed by
// 0013). This test turns it into a CI failure: every base table carrying a
// tenant-key column must have row security enabled, forced, and at least one
// policy — or be on the documented allowlist below.

const TENANT_KEY_COLUMNS = ["firm_id", "client_party_id", "party_id"];

// Deliberate exemptions. Every entry needs a reason a reviewer can check.
const ALLOWLIST: Record<string, string> = {
  // appendAudit runs inside EVERY tenant transaction and must both INSERT and
  // read the global chain tail (ORDER BY seq) regardless of tenant — scoping
  // it means per-firm chains, a planned redesign, not a policy. Integrity is
  // held by the append-only trigger; reads are operator/auditor-gated at the
  // route layer.
  audit_events: "global hash chain written from every tenant context",
};

test("every tenant-keyed table has an RLS policy or a documented exemption", async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set to run migration tests");
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    // The suite may run before or after rollback.test.ts in this package;
    // asserting coverage only makes sense in the fully-migrated state.
    await applyMigrations(pool);

    const { rows } = await pool.query<{
      table_name: string;
      rls_enabled: boolean;
      rls_forced: boolean;
      policies: number;
    }>(
      `SELECT c.table_name,
              k.relrowsecurity AS rls_enabled,
              k.relforcerowsecurity AS rls_forced,
              (SELECT count(*)::int FROM pg_policies p
                 WHERE p.schemaname = 'public'
                   AND p.tablename = c.table_name) AS policies
       FROM (SELECT DISTINCT col.table_name
               FROM information_schema.columns col
               JOIN information_schema.tables t
                 ON t.table_name = col.table_name
                AND t.table_schema = 'public'
              WHERE col.table_schema = 'public'
                AND t.table_type = 'BASE TABLE'
                AND col.column_name = ANY($1)) c
       JOIN pg_class k ON k.relname = c.table_name
       JOIN pg_namespace n ON n.oid = k.relnamespace AND n.nspname = 'public'
       ORDER BY c.table_name`,
      [TENANT_KEY_COLUMNS],
    );

    assert.ok(rows.length > 0, "enumeration found tenant-keyed tables");

    const uncovered = rows.filter(
      (r) =>
        !(r.rls_enabled && r.rls_forced && r.policies > 0) &&
        !(r.table_name in ALLOWLIST),
    );
    assert.deepEqual(
      uncovered.map((r) => r.table_name),
      [],
      "tenant-keyed tables without RLS coverage — add a policy in a new " +
        "guardrail migration (see 0013) or a justified ALLOWLIST entry: " +
        JSON.stringify(uncovered),
    );

    // The allowlist must stay honest: an entry for a table that no longer
    // exists (or that has since gained a policy) is stale and must be removed.
    for (const name of Object.keys(ALLOWLIST)) {
      const row = rows.find((r) => r.table_name === name);
      assert.ok(row, `ALLOWLIST entry '${name}' matches no tenant-keyed table`);
      assert.equal(
        row.policies,
        0,
        `ALLOWLIST entry '${name}' is stale — the table now has a policy`,
      );
    }
  } finally {
    await pool.end();
  }
});
