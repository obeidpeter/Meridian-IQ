export const migration0052 = {
  version: 52,
  name: "invoice_drafts",
  up: `
CREATE TABLE IF NOT EXISTS invoice_drafts (
  firm_id uuid NOT NULL REFERENCES firms(id),
  user_id text NOT NULL,
  client_party_id uuid NOT NULL REFERENCES parties(id),
  id uuid NOT NULL,
  revision integer NOT NULL DEFAULT 1 CONSTRAINT invoice_drafts_revision_check CHECK (revision > 0),
  write_id uuid NOT NULL,
  content jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  deleted_at timestamptz,
  PRIMARY KEY (firm_id, user_id, client_party_id, id)
);
CREATE INDEX IF NOT EXISTS invoice_drafts_owner_idx ON invoice_drafts (firm_id, user_id, client_party_id, updated_at);
CREATE INDEX IF NOT EXISTS invoice_drafts_expiry_idx ON invoice_drafts (expires_at) WHERE content <> '{}'::jsonb;
GRANT SELECT, INSERT, UPDATE ON invoice_drafts TO meridian_app;
REVOKE DELETE ON invoice_drafts FROM meridian_app;
ALTER TABLE invoice_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_drafts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_tenant_isolation ON invoice_drafts;
CREATE POLICY meridian_tenant_isolation ON invoice_drafts
  USING (current_setting('app.bypass', true) = 'on' OR (
    firm_id = nullif(current_setting('app.firm_id', true), '')::uuid
    AND user_id = current_setting('app.invoice_draft_user_id', true)
    AND client_party_id = nullif(current_setting('app.invoice_draft_client_id', true), '')::uuid))
  WITH CHECK (current_setting('app.bypass', true) = 'on' OR (
    firm_id = nullif(current_setting('app.firm_id', true), '')::uuid
    AND user_id = current_setting('app.invoice_draft_user_id', true)
    AND client_party_id = nullif(current_setting('app.invoice_draft_client_id', true), '')::uuid));
`,
  // Older applications ignore this additive table. Never erase recovery on rollback.
  down: "SELECT 1; -- Preserve invoice drafts, revision tombstones, grants and RLS.",
};
