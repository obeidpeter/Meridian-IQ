// Migration 0026 — governance + collections guardrails (compliance round).
//
// Three new firm-keyed tenant tables (0018/0023 posture — firm principals
// reach only their own rows, sweeps and operators run with app.bypass):
//   firm_policies        governance switches (maker-checker submit approval)
//   invoice_approvals    submission approvals — evidence, revoked not deleted
//   collection_accounts  provisioned virtual-account references
//
// Also extends meridian_purge_expired: invoice_approvals carries an
// invoice_id FK, so the purge must delete its rows before deleting invoices
// (the same reason 0023 added bill_verifications and chase_log). `down`
// restores the 0023 function verbatim.

const FIRM_MATCH =
  "firm_id = nullif(current_setting('app.firm_id', true), '')::uuid";

// The 0023 purge body, with invoice_approvals added.
const PURGE_WITH_APPROVALS = `
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
  DELETE FROM invoice_approvals WHERE invoice_id = ANY(ids);
  DELETE FROM bill_verifications WHERE invoice_id = ANY(ids);
  DELETE FROM chase_log WHERE invoice_id = ANY(ids);
  DELETE FROM match_proposals WHERE invoice_id = ANY(ids);
  DELETE FROM b2c_report_items WHERE invoice_id = ANY(ids);
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
`;

// The 0023 purge body, verbatim, for rollback.
const PURGE_0023 = `
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
  DELETE FROM bill_verifications WHERE invoice_id = ANY(ids);
  DELETE FROM chase_log WHERE invoice_id = ANY(ids);
  DELETE FROM match_proposals WHERE invoice_id = ANY(ids);
  DELETE FROM b2c_report_items WHERE invoice_id = ANY(ids);
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
`;

const TABLES = ["firm_policies", "invoice_approvals", "collection_accounts"];

const up = `
${TABLES.map(
  (t) => `
ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_clerk_tenant ON ${t};
CREATE POLICY meridian_clerk_tenant ON ${t}
  USING (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH})
  WITH CHECK (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH});`,
).join("\n")}
${PURGE_WITH_APPROVALS}
`;

const down = `
${TABLES.map(
  (t) => `
DROP POLICY IF EXISTS meridian_clerk_tenant ON ${t};
ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY;
ALTER TABLE ${t} DISABLE ROW LEVEL SECURITY;`,
).join("\n")}
${PURGE_0023}
`;

export const migration0026 = {
  version: 26,
  name: "governance_collections_guardrails",
  up,
  down,
};
