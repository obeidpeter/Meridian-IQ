// Migration 0008 — invitation onboarding guardrails (IDN-01).
//
// Firm-keyed row-level security on the invitations table, matching the posture
// of migrations 0001/0002/0007. A firm_admin (firm-scoped, RLS-enforced) only
// sees and mutates its own firm's invitations; the public accept-invite path
// runs in a bypass context (no principal) and reads by the unguessable token
// hash, which the bypass clause permits. Idempotent `up`, reversed by `down`
// (covered by the rollback test).

const FIRM_MATCH =
  "firm_id = nullif(current_setting('app.firm_id', true), '')::uuid";

const up = `
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_tenant_isolation ON invitations;
CREATE POLICY meridian_tenant_isolation ON invitations
  USING (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH})
  WITH CHECK (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH});
`;

const down = `
DROP POLICY IF EXISTS meridian_tenant_isolation ON invitations;
ALTER TABLE invitations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE invitations DISABLE ROW LEVEL SECURITY;
`;

export const migration0008 = {
  version: 8,
  name: "invitations_guardrails",
  up,
  down,
};
