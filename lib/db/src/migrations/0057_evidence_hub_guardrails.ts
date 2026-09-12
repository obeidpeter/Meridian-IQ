const TABLES = ["evidence_requests", "evidence_files", "evidence_events"];

// The supported post-merge path runs reviewed migrations, not Drizzle push.
// These declarations also make migration-only upgrades from version 56 complete.
const createEvidenceSchema = `
DO $$ BEGIN
  IF to_regtype('public.evidence_status') IS NULL THEN
    CREATE TYPE public.evidence_status AS ENUM ('requested', 'uploaded', 'needs_changes', 'accepted', 'cancelled');
  END IF;
  IF to_regtype('public.evidence_document_type') IS NULL THEN
    CREATE TYPE public.evidence_document_type AS ENUM ('purchase_order', 'delivery_note', 'payment_receipt', 'tax_acknowledgement', 'contract', 'other');
  END IF;
  IF to_regtype('public.evidence_scan_status') IS NULL THEN
    CREATE TYPE public.evidence_scan_status AS ENUM ('quarantined', 'clean', 'rejected');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS evidence_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id),
  client_party_id uuid NOT NULL REFERENCES parties(id),
  invoice_id uuid REFERENCES invoices(id),
  filing_id uuid REFERENCES filing_returns(id),
  period text,
  title text NOT NULL,
  description text,
  document_type public.evidence_document_type NOT NULL,
  status public.evidence_status NOT NULL DEFAULT 'requested',
  owner_id uuid NOT NULL REFERENCES users(id),
  created_by uuid NOT NULL REFERENCES users(id),
  due_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  latest_file_id uuid,
  accepted_file_id uuid,
  client_request_id uuid NOT NULL,
  request_hash text NOT NULL,
  last_reminder_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS evidence_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id),
  request_id uuid NOT NULL REFERENCES evidence_requests(id),
  filename text NOT NULL,
  content_type text NOT NULL,
  byte_size integer NOT NULL,
  sha256 text NOT NULL,
  encrypted_content text NOT NULL,
  scan_status public.evidence_scan_status NOT NULL DEFAULT 'quarantined',
  scan_error text,
  scan_attempts integer NOT NULL DEFAULT 0,
  next_scan_at timestamptz NOT NULL DEFAULT now(),
  scan_token uuid,
  lease_until timestamptz,
  uploaded_by uuid NOT NULL REFERENCES users(id),
  client_request_id uuid NOT NULL,
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  scanned_at timestamptz
);
CREATE TABLE IF NOT EXISTS evidence_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id),
  request_id uuid NOT NULL REFERENCES evidence_requests(id),
  actor_id uuid REFERENCES users(id),
  action text NOT NULL,
  comment text,
  file_id uuid REFERENCES evidence_files(id),
  client_request_id uuid,
  request_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS evidence_requests_firm_command_uq
  ON evidence_requests (firm_id, client_request_id);
CREATE INDEX IF NOT EXISTS evidence_requests_client_status_idx
  ON evidence_requests (firm_id, client_party_id, status);
CREATE INDEX IF NOT EXISTS evidence_requests_due_idx ON evidence_requests (status, due_at);
CREATE INDEX IF NOT EXISTS evidence_requests_invoice_idx ON evidence_requests (invoice_id);
CREATE INDEX IF NOT EXISTS evidence_requests_filing_idx ON evidence_requests (filing_id);
CREATE UNIQUE INDEX IF NOT EXISTS evidence_files_request_command_uq
  ON evidence_files (request_id, client_request_id);
CREATE INDEX IF NOT EXISTS evidence_files_firm_idx ON evidence_files (firm_id);
CREATE INDEX IF NOT EXISTS evidence_files_scan_queue_idx ON evidence_files (scan_status, next_scan_at);
CREATE UNIQUE INDEX IF NOT EXISTS evidence_events_request_command_uq
  ON evidence_events (request_id, client_request_id);
CREATE INDEX IF NOT EXISTS evidence_events_request_created_idx ON evidence_events (request_id, created_at);
CREATE INDEX IF NOT EXISTS evidence_events_firm_idx ON evidence_events (firm_id);
GRANT SELECT, INSERT, UPDATE ON evidence_requests, evidence_files TO meridian_app;
REVOKE DELETE ON evidence_requests, evidence_files FROM meridian_app;
GRANT SELECT, INSERT ON evidence_events TO meridian_app;
REVOKE UPDATE, DELETE ON evidence_events FROM meridian_app;
`;

const tenantPolicy = (table: string): string => `
ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_tenant_isolation ON ${table};
CREATE POLICY meridian_tenant_isolation ON ${table}
  USING (current_setting('app.bypass', true) = 'on'
    OR firm_id = nullif(current_setting('app.firm_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass', true) = 'on'
    OR firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);
`;

const CONSTRAINTS = [
  [
    "evidence_requests",
    "evidence_requests_one_anchor",
    "CHECK (num_nonnulls(invoice_id, filing_id, period) = 1)",
  ],
  [
    "evidence_requests",
    "evidence_requests_valid_period",
    "CHECK (period IS NULL OR (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' AND left(period, 4) <> '0000'))",
  ],
  [
    "evidence_requests",
    "evidence_requests_positive_version",
    "CHECK (version > 0)",
  ],
  [
    "evidence_requests",
    "evidence_requests_acceptance_pointer",
    "CHECK (status <> 'accepted' OR (accepted_file_id IS NOT NULL AND latest_file_id IS NOT NULL AND accepted_file_id = latest_file_id))",
  ],
  [
    "evidence_requests",
    "evidence_requests_unaccepted_pointer",
    "CHECK (status = 'accepted' OR accepted_file_id IS NULL)",
  ],
  [
    "evidence_requests",
    "evidence_requests_requested_pointer",
    "CHECK (status <> 'requested' OR latest_file_id IS NULL)",
  ],
  [
    "evidence_requests",
    "evidence_requests_uploaded_pointer",
    "CHECK (status <> 'uploaded' OR latest_file_id IS NOT NULL)",
  ],
  [
    "evidence_files",
    "evidence_files_valid_byte_size",
    "CHECK (byte_size BETWEEN 1 AND 5242880)",
  ],
  [
    "evidence_files",
    "evidence_files_supported_content_type",
    "CHECK (content_type IN ('application/pdf', 'image/png', 'image/jpeg'))",
  ],
  [
    "evidence_files",
    "evidence_files_valid_sha256",
    "CHECK (sha256 ~ '^[0-9a-f]{64}$')",
  ],
  [
    "evidence_files",
    "evidence_files_request_firm_fk",
    "FOREIGN KEY (firm_id, request_id) REFERENCES evidence_requests (firm_id, id)",
  ],
  [
    "evidence_events",
    "evidence_events_request_firm_fk",
    "FOREIGN KEY (firm_id, request_id) REFERENCES evidence_requests (firm_id, id)",
  ],
  [
    "evidence_requests",
    "evidence_requests_latest_file_fk",
    "FOREIGN KEY (id, latest_file_id) REFERENCES evidence_files (request_id, id) DEFERRABLE INITIALLY DEFERRED",
  ],
  [
    "evidence_requests",
    "evidence_requests_accepted_file_fk",
    "FOREIGN KEY (id, accepted_file_id) REFERENCES evidence_files (request_id, id) DEFERRABLE INITIALLY DEFERRED",
  ],
  [
    "evidence_events",
    "evidence_events_request_file_fk",
    "FOREIGN KEY (request_id, file_id) REFERENCES evidence_files (request_id, id) DEFERRABLE INITIALLY DEFERRED",
  ],
] as const;

// Drizzle introspection hides composite indexes used by these FKs and then tries
// to recreate them on repeat Publish. Keep their ownership with the guardrails.
const compositeIndexes = `
CREATE UNIQUE INDEX IF NOT EXISTS evidence_requests_firm_id_uq
  ON evidence_requests (firm_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS evidence_files_request_id_uq
  ON evidence_files (request_id, id);
`;

// Guardrails must fail on bad existing data, not silently repair evidence or
// weaken constraints. The declarations above mirror the shared Drizzle schema.
const constraintsUp = CONSTRAINTS.map(
  ([table, name, definition]) => `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = '${table}'::regclass AND conname = '${name}') THEN
    ALTER TABLE ${table} ADD CONSTRAINT ${name} ${definition};
  END IF;
END $$;
`,
).join("");

export const migration0057 = {
  version: 57,
  name: "evidence_hub_guardrails",
  up:
    // PostgreSQL must commit this enum addition before a later transaction uses
    // it. This migration only installs guardrails; no reminder rows are written.
    "ALTER TYPE message_channel ADD VALUE IF NOT EXISTS 'in_app';\n" +
    createEvidenceSchema +
    TABLES.map(tenantPolicy).join("") +
    compositeIndexes +
    constraintsUp +
    `
CREATE OR REPLACE FUNCTION meridian_evidence_request_guard()
RETURNS trigger AS $$
DECLARE
  anchored_id uuid;
  accepted_status text;
BEGIN
  IF TG_OP = 'UPDATE' AND
    ROW(NEW.id, NEW.firm_id, NEW.client_party_id, NEW.invoice_id,
      NEW.filing_id, NEW.period, NEW.created_by, NEW.created_at,
      NEW.client_request_id, NEW.request_hash)
    IS DISTINCT FROM
    ROW(OLD.id, OLD.firm_id, OLD.client_party_id, OLD.invoice_id,
      OLD.filing_id, OLD.period, OLD.created_by, OLD.created_at,
      OLD.client_request_id, OLD.request_hash) THEN
    RAISE EXCEPTION 'evidence request scope, anchor and creator are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.invoice_id IS NOT NULL THEN
    SELECT id INTO anchored_id FROM invoices
      WHERE id = NEW.invoice_id AND firm_id = NEW.firm_id
        AND supplier_party_id = NEW.client_party_id FOR SHARE;
    IF anchored_id IS NULL THEN
      RAISE EXCEPTION 'evidence invoice anchor must match the firm and client'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.filing_id IS NOT NULL THEN
    SELECT id INTO anchored_id FROM filing_returns
      WHERE id = NEW.filing_id AND firm_id = NEW.firm_id
        AND client_party_id = NEW.client_party_id FOR SHARE;
    IF anchored_id IS NULL THEN
      RAISE EXCEPTION 'evidence filing anchor must match the firm and client'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.status = 'accepted' THEN
    -- Lock the same immutable version a scanner updates. Whichever operation
    -- wins first determines whether acceptance or a retry must be rejected.
    SELECT scan_status::text INTO accepted_status FROM evidence_files
      WHERE id = NEW.accepted_file_id AND request_id = NEW.id
        AND firm_id = NEW.firm_id FOR UPDATE;
    IF accepted_status IS DISTINCT FROM 'clean' THEN
      RAISE EXCEPTION 'accepted evidence must reference a clean file version'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;

CREATE OR REPLACE FUNCTION meridian_evidence_file_guard()
RETURNS trigger AS $$
DECLARE
  accepted_id uuid;
  scanner_fields text[] := ARRAY['scan_status', 'scan_error', 'scan_attempts',
    'next_scan_at', 'scan_token', 'lease_until', 'scanned_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'evidence file versions cannot be deleted'
      USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - scanner_fields) IS DISTINCT FROM
    (to_jsonb(OLD) - scanner_fields) THEN
    RAISE EXCEPTION 'evidence file identity, content and metadata are immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.scan_status IS DISTINCT FROM OLD.scan_status THEN
    SELECT accepted_file_id INTO accepted_id FROM evidence_requests
      WHERE id = OLD.request_id AND firm_id = OLD.firm_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'evidence file request is unavailable'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.scan_status <> 'clean' AND (accepted_id = OLD.id OR EXISTS (
      SELECT 1 FROM evidence_events WHERE request_id = OLD.request_id
        AND file_id = OLD.id AND action = 'accepted'
    )) THEN
      RAISE EXCEPTION 'accepted evidence cannot be quarantined or rejected'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;

CREATE OR REPLACE FUNCTION meridian_evidence_invoice_anchor_guard()
RETURNS trigger AS $$
BEGIN
  IF ROW(NEW.id, NEW.firm_id, NEW.supplier_party_id) IS DISTINCT FROM
    ROW(OLD.id, OLD.firm_id, OLD.supplier_party_id)
    AND EXISTS (SELECT 1 FROM evidence_requests WHERE invoice_id = OLD.id) THEN
    RAISE EXCEPTION 'an invoice with evidence cannot change firm or client'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;

CREATE OR REPLACE FUNCTION meridian_evidence_filing_anchor_guard()
RETURNS trigger AS $$
BEGIN
  IF ROW(NEW.id, NEW.firm_id, NEW.client_party_id) IS DISTINCT FROM
    ROW(OLD.id, OLD.firm_id, OLD.client_party_id)
    AND EXISTS (SELECT 1 FROM evidence_requests WHERE filing_id = OLD.id) THEN
    RAISE EXCEPTION 'a filing with evidence cannot change firm or client'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;

CREATE OR REPLACE FUNCTION meridian_evidence_event_guard()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'evidence events are append-only'
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;

DROP TRIGGER IF EXISTS meridian_evidence_request_guard ON evidence_requests;
CREATE TRIGGER meridian_evidence_request_guard BEFORE INSERT OR UPDATE
  ON evidence_requests FOR EACH ROW EXECUTE FUNCTION meridian_evidence_request_guard();
DROP TRIGGER IF EXISTS meridian_evidence_file_guard ON evidence_files;
CREATE TRIGGER meridian_evidence_file_guard BEFORE UPDATE OR DELETE
  ON evidence_files FOR EACH ROW EXECUTE FUNCTION meridian_evidence_file_guard();
DROP TRIGGER IF EXISTS meridian_append_only ON evidence_events;
CREATE TRIGGER meridian_append_only BEFORE UPDATE OR DELETE ON evidence_events
  FOR EACH ROW EXECUTE FUNCTION meridian_evidence_event_guard();
DROP TRIGGER IF EXISTS meridian_evidence_invoice_anchor_guard ON invoices;
CREATE TRIGGER meridian_evidence_invoice_anchor_guard
  BEFORE UPDATE OF id, firm_id, supplier_party_id ON invoices
  FOR EACH ROW EXECUTE FUNCTION meridian_evidence_invoice_anchor_guard();
DROP TRIGGER IF EXISTS meridian_evidence_filing_anchor_guard ON filing_returns;
CREATE TRIGGER meridian_evidence_filing_anchor_guard
  BEFORE UPDATE OF id, firm_id, client_party_id ON filing_returns
  FOR EACH ROW EXECUTE FUNCTION meridian_evidence_filing_anchor_guard();

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM evidence_requests r LEFT JOIN invoices i ON i.id = r.invoice_id
    WHERE r.invoice_id IS NOT NULL AND
      (i.id IS NULL OR i.firm_id <> r.firm_id OR i.supplier_party_id <> r.client_party_id))
    OR EXISTS (SELECT 1 FROM evidence_requests r LEFT JOIN filing_returns f ON f.id = r.filing_id
      WHERE r.filing_id IS NOT NULL AND
        (f.id IS NULL OR f.firm_id <> r.firm_id OR f.client_party_id <> r.client_party_id)) THEN
    RAISE EXCEPTION 'existing evidence has an invalid invoice or filing anchor'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM evidence_requests r LEFT JOIN evidence_files f
    ON f.id = r.accepted_file_id AND f.request_id = r.id AND f.firm_id = r.firm_id
    WHERE r.status = 'accepted' AND (f.id IS NULL OR f.scan_status <> 'clean')) THEN
    RAISE EXCEPTION 'existing accepted evidence has no clean file version'
      USING ERRCODE = '23514';
  END IF;
END $$;
`,
  // An older application does not need these protections removed. Retained
  // private documents, reviews and accepted versions stay protected on rollback.
  down: `SELECT 1;`,
};
