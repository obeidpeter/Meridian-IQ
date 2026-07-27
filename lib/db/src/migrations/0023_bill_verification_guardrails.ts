// Migration 0023 — bill-verification guardrails (payables round).
//
// bill_verifications records per-bill stamp checks — tenant data. Same
// firm-keyed-or-bypass posture as chase_log (0018): a firm principal
// (including its client_users; SEC-03 narrowing is the module's job) reads
// and writes only its own rows; sweeps and operators run with app.bypass.
//
// Also extends meridian_purge_expired: the function must delete every child
// that references invoice_id before deleting invoices, and it predates BOTH
// bill_verifications (new) and chase_log (0018 omitted it — a latent FK
// violation on purge, fixed here). `down` restores the 0002 version
// verbatim, matching what a rollback past this migration should leave.

const FIRM_MATCH =
  "firm_id = nullif(current_setting('app.firm_id', true), '')::uuid";

// The 0002 purge body, with the two missing child deletes added.
const PURGE_WITH_BILL_TABLES = `
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

// The 0002 purge body, verbatim, for rollback.
const PURGE_0002 = `
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

const up = `
ALTER TABLE bill_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE bill_verifications FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_clerk_tenant ON bill_verifications;
CREATE POLICY meridian_clerk_tenant ON bill_verifications
  USING (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH})
  WITH CHECK (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH});
${PURGE_WITH_BILL_TABLES}
`;

const down = `
DROP POLICY IF EXISTS meridian_clerk_tenant ON bill_verifications;
ALTER TABLE bill_verifications NO FORCE ROW LEVEL SECURITY;
ALTER TABLE bill_verifications DISABLE ROW LEVEL SECURITY;
${PURGE_0002}
`;

export const migration0023 = {
  version: 23,
  name: "bill_verification_guardrails",
  up,
  down,
};
