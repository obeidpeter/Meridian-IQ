// Migration 0055 — permanent one-time production bootstrap consumption.
//
// The first-operator bootstrap is an exceptional path used only when production
// has no real operator. A durable singleton claim prevents retained deployment
// settings from ever creating a second privileged identity, even if the original
// operator is later removed.

export const migration0055 = {
  version: 55,
  name: "production_bootstrap_claims",
  up: `
CREATE TABLE IF NOT EXISTS production_bootstrap_claims (
  key text PRIMARY KEY,
  operator_user_id uuid NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON production_bootstrap_claims TO meridian_app;
REVOKE UPDATE, DELETE ON production_bootstrap_claims FROM meridian_app;

ALTER TABLE production_bootstrap_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_bootstrap_claims FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_production_bootstrap_bypass
  ON production_bootstrap_claims;
CREATE POLICY meridian_production_bootstrap_bypass
  ON production_bootstrap_claims
  USING (current_setting('app.bypass', true) = 'on')
  WITH CHECK (current_setting('app.bypass', true) = 'on');

CREATE OR REPLACE FUNCTION meridian_bootstrap_claim_immutable()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'production bootstrap claims are immutable'
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS meridian_bootstrap_claim_immutable
  ON production_bootstrap_claims;
CREATE TRIGGER meridian_bootstrap_claim_immutable
  BEFORE UPDATE OR DELETE ON production_bootstrap_claims
  FOR EACH ROW EXECUTE FUNCTION meridian_bootstrap_claim_immutable();
`,
  // Intentionally irreversible: rolling application code back must not erase a
  // consumed privileged-bootstrap claim and make retained credentials usable
  // again. A database administrator can still remove these objects explicitly
  // during a separately governed full data reset.
  down: `SELECT 1;`,
};
