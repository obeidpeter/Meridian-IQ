// Migration 0001 — data-layer guardrails (CORE-02, CORE-06, CORE-07, SEC-02).
//
// These objects cannot be expressed in the Drizzle table schema (triggers, RLS
// policies, retention functions), so they live as versioned SQL applied by the
// migration runner. The `up` SQL is written idempotently so it can also be
// re-asserted on every boot; `down` fully reverses it and is covered by a
// rollback test.

const APPEND_ONLY_TABLES = [
  "submission_attempts",
  "stamp_records",
  "confirmations",
  "settlement_events",
  "consent_records",
  "audit_events",
  "invoice_lifecycle_events",
];

const TENANT_TABLES = [
  "invoices",
  "engagements",
  "invoice_lifecycle_events",
  "feature_flag_overrides",
];

const INVOICE_SCOPED_TABLES = [
  "invoice_lines",
  "submission_attempts",
  "stamp_records",
  "confirmations",
  "settlement_events",
];

const FIRM_MATCH =
  "firm_id = nullif(current_setting('app.firm_id', true), '')::uuid";

function invoiceScopedMatch(table: string): string {
  return `EXISTS (SELECT 1 FROM invoices i WHERE i.id = ${table}.invoice_id AND i.firm_id = nullif(current_setting('app.firm_id', true), '')::uuid)`;
}

const up = `
-- ============ SEC-02 / CON-01: restricted application role ============
-- Replit's managed Postgres only exposes a superuser (BYPASSRLS) login, which
-- would silently skip every RLS policy below. The app therefore SET LOCAL ROLE
-- to this non-privileged, non-BYPASSRLS role inside each request transaction
-- (see lib/db/src/context.ts) so the policies are actually enforced. Tenant
-- separation lives in the database, not just in handler guards.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'meridian_app') THEN
    CREATE ROLE meridian_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO meridian_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO meridian_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO meridian_app;
-- Future tables created by the migrator (drizzle push / later migrations) inherit
-- the same grants automatically.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO meridian_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO meridian_app;

-- ============ CORE-02: append-only enforcement ============
CREATE OR REPLACE FUNCTION meridian_block_mutations() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'append_only_violation: % rows are immutable and cannot be updated', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF current_setting('app.allow_purge', true) = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'append_only_violation: % rows are immutable and cannot be deleted', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END; $$ LANGUAGE plpgsql;

${APPEND_ONLY_TABLES.map(
  (t) => `DROP TRIGGER IF EXISTS meridian_append_only ON ${t};
CREATE TRIGGER meridian_append_only BEFORE UPDATE OR DELETE ON ${t}
  FOR EACH ROW EXECUTE FUNCTION meridian_block_mutations();`,
).join("\n")}

-- ============ CORE-07: retention window (default 7y, min 24m) ============
CREATE OR REPLACE FUNCTION meridian_set_retention() RETURNS trigger AS $$
DECLARE
  min_until date := (NEW.issue_date::date + INTERVAL '24 months')::date;
  std_until date := (NEW.issue_date::date + INTERVAL '7 years')::date;
BEGIN
  IF NEW.retention_until IS NULL THEN
    NEW.retention_until := std_until;
  END IF;
  IF NEW.retention_until < min_until THEN
    NEW.retention_until := min_until;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS meridian_set_retention ON invoices;
CREATE TRIGGER meridian_set_retention BEFORE INSERT OR UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION meridian_set_retention();

-- ============ CORE-02/CORE-07: invoice immutability + retention delete guard ==
CREATE OR REPLACE FUNCTION meridian_enforce_invoice_immutability() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('app.allow_purge', true) = 'on'
       AND OLD.legal_hold = false
       AND OLD.retention_until IS NOT NULL
       AND OLD.retention_until <= now()::date THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'invoice_delete_blocked: invoice % is under retention or legal hold', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'draft' THEN
    IF NEW.supplier_party_id <> OLD.supplier_party_id
       OR NEW.buyer_party_id <> OLD.buyer_party_id
       OR NEW.invoice_number <> OLD.invoice_number
       OR NEW.currency <> OLD.currency
       OR NEW.issue_date <> OLD.issue_date
       OR NEW.kind <> OLD.kind
       OR NEW.category <> OLD.category
       OR NEW.subtotal <> OLD.subtotal
       OR NEW.vat_total <> OLD.vat_total
       OR NEW.grand_total <> OLD.grand_total THEN
      RAISE EXCEPTION 'immutable_invoice: financial content of invoice % is immutable after submission', OLD.id
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS meridian_invoice_immutability ON invoices;
CREATE TRIGGER meridian_invoice_immutability BEFORE UPDATE OR DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION meridian_enforce_invoice_immutability();

CREATE OR REPLACE FUNCTION meridian_enforce_line_immutability() RETURNS trigger AS $$
DECLARE st text;
BEGIN
  SELECT status INTO st FROM invoices WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);
  IF st IS NOT NULL AND st <> 'draft' THEN
    IF TG_OP = 'DELETE' AND current_setting('app.allow_purge', true) = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'immutable_invoice_line: lines are immutable after submission'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS meridian_line_immutability ON invoice_lines;
CREATE TRIGGER meridian_line_immutability BEFORE UPDATE OR DELETE ON invoice_lines
  FOR EACH ROW EXECUTE FUNCTION meridian_enforce_line_immutability();

-- ============ CORE-07: retention purge (respects legal hold) ============
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

-- ============ SEC-02 / CON-01: row-level tenant isolation ============
${TENANT_TABLES.map(
  (t) => `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_tenant_isolation ON ${t};
CREATE POLICY meridian_tenant_isolation ON ${t}
  USING (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH})
  WITH CHECK (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH});`,
).join("\n")}

${INVOICE_SCOPED_TABLES.map(
  (t) => `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_tenant_isolation ON ${t};
CREATE POLICY meridian_tenant_isolation ON ${t}
  USING (current_setting('app.bypass', true) = 'on' OR ${invoiceScopedMatch(t)})
  WITH CHECK (current_setting('app.bypass', true) = 'on' OR ${invoiceScopedMatch(t)});`,
).join("\n")}
`;

const RLS_TABLES = [...TENANT_TABLES, ...INVOICE_SCOPED_TABLES];

const down = `
${RLS_TABLES.map(
  (t) => `DROP POLICY IF EXISTS meridian_tenant_isolation ON ${t};
ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY;
ALTER TABLE ${t} DISABLE ROW LEVEL SECURITY;`,
).join("\n")}

${APPEND_ONLY_TABLES.map(
  (t) => `DROP TRIGGER IF EXISTS meridian_append_only ON ${t};`,
).join("\n")}
DROP TRIGGER IF EXISTS meridian_line_immutability ON invoice_lines;
DROP TRIGGER IF EXISTS meridian_invoice_immutability ON invoices;
DROP TRIGGER IF EXISTS meridian_set_retention ON invoices;

DROP FUNCTION IF EXISTS meridian_purge_expired();
DROP FUNCTION IF EXISTS meridian_enforce_line_immutability();
DROP FUNCTION IF EXISTS meridian_enforce_invoice_immutability();
DROP FUNCTION IF EXISTS meridian_set_retention();
DROP FUNCTION IF EXISTS meridian_block_mutations();

-- Tear down the restricted application role. DROP OWNED BY removes every grant
-- and default-privilege entry attached to it so DROP ROLE can succeed.
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'meridian_app') THEN
    DROP OWNED BY meridian_app;
    DROP ROLE meridian_app;
  END IF;
END $$;
`;

export const migration0001 = {
  version: 1,
  name: "guardrails",
  up,
  down,
};
