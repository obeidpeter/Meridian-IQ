export const migration0053 = {
  version: 53,
  name: "clerk_reservations",
  up: `
CREATE TABLE IF NOT EXISTS clerk_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id),
  reserved_tokens bigint NOT NULL CONSTRAINT clerk_reservations_tokens_positive CHECK (reserved_tokens > 0),
  month_start timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  settled_at timestamptz,
  inference_call_id uuid UNIQUE REFERENCES clerk_inference_calls(id),
  provider_call_id uuid UNIQUE REFERENCES clerk_inference_calls(id),
  CONSTRAINT clerk_reservations_settlement CHECK ((settled_at IS NULL) = (inference_call_id IS NULL))
);
CREATE INDEX IF NOT EXISTS clerk_reservations_unsettled_idx
  ON clerk_reservations(firm_id) WHERE settled_at IS NULL;
ALTER TABLE clerk_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE clerk_reservations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_bypass_only ON clerk_reservations;
CREATE POLICY meridian_bypass_only ON clerk_reservations
  USING (current_setting('app.bypass', true) = 'on')
  WITH CHECK (current_setting('app.bypass', true) = 'on');
GRANT SELECT, INSERT, UPDATE ON clerk_reservations TO meridian_app;
REVOKE DELETE ON clerk_reservations FROM meridian_app;
`,
  // Additive compatibility: old binaries ignore the table, but still read its
  // reconciled charges in the inference ledger. Preserve rows, grants and RLS.
  down: `SELECT 1;`,
};
