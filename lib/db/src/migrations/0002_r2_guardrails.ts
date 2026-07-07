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
-- ============ Legacy membership dedupe ============
-- The memberships unique index is being tightened to five columns with NULLS
-- NOT DISTINCT (see lib/db/src/schema/organizations.ts). Databases seeded
-- before the tightening accumulated duplicate rows (NULLS DISTINCT never
-- conflicted), which would make the new index impossible to create. Keep the
-- earliest row of each binding. Idempotent and safe on fresh databases.
DELETE FROM memberships a
  USING memberships b
  WHERE a.created_at > b.created_at
    AND a.user_id = b.user_id
    AND a.role = b.role
    AND a.firm_id IS NOT DISTINCT FROM b.firm_id
    AND a.client_party_id IS NOT DISTINCT FROM b.client_party_id;

-- ============ CORE-07: retention purge covers the R2 spine ============
-- The R2 tables reference invoices (match_proposals.invoice_id,
-- b2c_report_items.invoice_id, invoices.related_invoice_id self-FK), so the
-- 0001 purge would now fail on FK violations. Extend it: purge R2 children
-- first, detach surviving adjustments from purged originals, then delete the
-- original chain.
CREATE OR REPLACE FUNCTION meridian_purge_expired() RETURNS integer AS $$
DECLARE ids uuid[];
BEGIN
  PERFORM set_config('app.allow_purge', 'on', true);
  PERFORM set_config('app.bypass', 'on', true);
  SELECT array_agg(id) INTO ids FROM invoices
    WHERE legal_hold = false
      AND retention_until IS NOT NULL
      AND retention_until <= now()::date;
  IF ids IS NULL THEN RETURN 0; END IF;
  DELETE FROM match_proposals WHERE invoice_id = ANY(ids);
  DELETE FROM b2c_report_items WHERE invoice_id = ANY(ids);
  -- An adjustment (credit note/correction) may outlive its original's
  -- retention window; detach it rather than blocking the purge.
  UPDATE invoices SET related_invoice_id = NULL
    WHERE related_invoice_id = ANY(ids) AND NOT (id = ANY(ids));
  DELETE FROM settlement_events WHERE invoice_id = ANY(ids);
  DELETE FROM confirmations WHERE invoice_id = ANY(ids);
  DELETE FROM stamp_records WHERE invoice_id = ANY(ids);
  DELETE FROM submission_attempts WHERE invoice_id = ANY(ids);
  DELETE FROM invoice_lifecycle_events WHERE invoice_id = ANY(ids);
  DELETE FROM invoice_lines WHERE invoice_id = ANY(ids);
  DELETE FROM invoices WHERE id = ANY(ids);
  RETURN array_length(ids, 1);
END; $$ LANGUAGE plpgsql;

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

-- Restore the 0001 purge function (without R2-table coverage).
CREATE OR REPLACE FUNCTION meridian_purge_expired() RETURNS integer AS $$
DECLARE ids uuid[];
BEGIN
  PERFORM set_config('app.allow_purge', 'on', true);
  PERFORM set_config('app.bypass', 'on', true);
  SELECT array_agg(id) INTO ids FROM invoices
    WHERE legal_hold = false
      AND retention_until IS NOT NULL
      AND retention_until <= now()::date;
  IF ids IS NULL THEN RETURN 0; END IF;
  DELETE FROM settlement_events WHERE invoice_id = ANY(ids);
  DELETE FROM confirmations WHERE invoice_id = ANY(ids);
  DELETE FROM stamp_records WHERE invoice_id = ANY(ids);
  DELETE FROM submission_attempts WHERE invoice_id = ANY(ids);
  DELETE FROM invoice_lifecycle_events WHERE invoice_id = ANY(ids);
  DELETE FROM invoice_lines WHERE invoice_id = ANY(ids);
  DELETE FROM invoices WHERE id = ANY(ids);
  RETURN array_length(ids, 1);
END; $$ LANGUAGE plpgsql;
`;

export const migration0002 = {
  version: 2,
  name: "r2_guardrails",
  up,
  down,
};
