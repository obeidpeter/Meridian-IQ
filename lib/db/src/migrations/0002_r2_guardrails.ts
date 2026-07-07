// Migration 0002 — R2 data-layer guardrails (SEC-03, SME-07, SME-08, CON-05,
// PL-03).
//
// Extends the tenant row-level-security posture of migration 0001 to the R2
// tables: firm-keyed RLS on the new tenant tables, and EXISTS-scoped policies
// for their child tables (statement lines via their statement, B2C items via
// their batch, sync runs via their connection). Written idempotently so it can
// be re-asserted on boot; `down` fully reverses it (covered by rollback test).
//
// buyer_exposure_snapshots and cpd_courses are deliberately NOT tenant-keyed:
// snapshots are buyer-party-scoped (buyer principals run in bypass with
// route-level scoping, like operators) and courses are shared platform content.

const R2_TENANT_TABLES = [
  "bank_statements",
  "match_proposals",
  "b2c_report_batches",
  "erp_connections",
  "cpd_enrollments",
];

const FIRM_MATCH =
  "firm_id = nullif(current_setting('app.firm_id', true), '')::uuid";

// Child tables scoped through their parent's firm_id.
const SCOPED: { table: string; match: string }[] = [
  {
    table: "bank_statement_lines",
    match: `EXISTS (SELECT 1 FROM bank_statements s WHERE s.id = bank_statement_lines.statement_id AND s.${FIRM_MATCH})`,
  },
  {
    table: "b2c_report_items",
    match: `EXISTS (SELECT 1 FROM b2c_report_batches b WHERE b.id = b2c_report_items.batch_id AND b.${FIRM_MATCH})`,
  },
  {
    table: "erp_sync_runs",
    match: `EXISTS (SELECT 1 FROM erp_connections c WHERE c.id = erp_sync_runs.connection_id AND c.${FIRM_MATCH})`,
  },
];

const up = `
${R2_TENANT_TABLES.map(
  (t) => `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_tenant_isolation ON ${t};
CREATE POLICY meridian_tenant_isolation ON ${t}
  USING (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH})
  WITH CHECK (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH});`,
).join("\n")}

${SCOPED.map(
  ({ table, match }) => `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_tenant_isolation ON ${table};
CREATE POLICY meridian_tenant_isolation ON ${table}
  USING (current_setting('app.bypass', true) = 'on' OR ${match})
  WITH CHECK (current_setting('app.bypass', true) = 'on' OR ${match});`,
).join("\n")}
`;

const ALL_TABLES = [...R2_TENANT_TABLES, ...SCOPED.map((s) => s.table)];

const down = `
${ALL_TABLES.map(
  (t) => `DROP POLICY IF EXISTS meridian_tenant_isolation ON ${t};
ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY;
ALTER TABLE ${t} DISABLE ROW LEVEL SECURITY;`,
).join("\n")}
`;

export const migration0002 = {
  version: 2,
  name: "r2_guardrails",
  up,
  down,
};
