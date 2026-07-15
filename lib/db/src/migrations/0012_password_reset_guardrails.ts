// Migration 0012 — password-reset guardrails (IDN-02).
//
// password_resets carries credential-recovery secrets (hashed) for users
// across every firm — exactly the class of table that must never be readable
// through a firm principal. Same bypass-only posture as the Clerk eval tables
// (0006/0010): the operator issue path and the public redeem path both run
// with app.bypass='on'; no firm-scoped context can see or mint reset rows.
// Idempotent `up`, reversed by `down` (rollback-test covered).

const up = `
ALTER TABLE password_resets ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_resets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_bypass_only ON password_resets;
CREATE POLICY meridian_bypass_only ON password_resets
  USING (current_setting('app.bypass', true) = 'on')
  WITH CHECK (current_setting('app.bypass', true) = 'on');
`;

const down = `
DROP POLICY IF EXISTS meridian_bypass_only ON password_resets;
ALTER TABLE password_resets NO FORCE ROW LEVEL SECURITY;
ALTER TABLE password_resets DISABLE ROW LEVEL SECURITY;
`;

export const migration0012 = {
  version: 12,
  name: "password_reset_guardrails",
  up,
  down,
};
