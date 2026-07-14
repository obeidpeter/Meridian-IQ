// Migration 0011 — weekly digest guardrails (Clerk power D).
//
// clerk_digests is tenant data: each row summarises ONE firm's compliance
// posture for a week. Same firm-keyed-or-bypass posture as 0009's Clerk
// tables — a firm principal reads only its own digests; operators and the
// generating sweep run with app.bypass='on'. Idempotent `up`, reversed by
// `down` (rollback-test covered).

const FIRM_MATCH =
  "firm_id = nullif(current_setting('app.firm_id', true), '')::uuid";

const up = `
ALTER TABLE clerk_digests ENABLE ROW LEVEL SECURITY;
ALTER TABLE clerk_digests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_clerk_tenant ON clerk_digests;
CREATE POLICY meridian_clerk_tenant ON clerk_digests
  USING (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH})
  WITH CHECK (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH});
`;

const down = `
DROP POLICY IF EXISTS meridian_clerk_tenant ON clerk_digests;
ALTER TABLE clerk_digests NO FORCE ROW LEVEL SECURITY;
ALTER TABLE clerk_digests DISABLE ROW LEVEL SECURITY;
`;

export const migration0011 = {
  version: 11,
  name: "digest_guardrails",
  up,
  down,
};
