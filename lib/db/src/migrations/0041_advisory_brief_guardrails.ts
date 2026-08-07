// Migration 0041 — advisory brief guardrails (round 49).
//
// clerk_advisory_briefs holds the per-client advisory briefs — firm-keyed
// tenant data, clerk-family policy (meridian_clerk_tenant, the 0014/0032/
// 0039 posture and BYTE-IDENTICAL qual, so the rls-policy-qual pin hash is
// shared): firm scope or bypass, forced RLS. Rows regenerate in place
// (the live-month upsert), so no append-only trigger. Client routes must
// ALSO narrow to the caller's party (SEC-03) — firm-keyed RLS is not a
// sibling wall. Idempotent `up`, reversed by `down`.

const FIRM_MATCH =
  "firm_id = nullif(current_setting('app.firm_id', true), '')::uuid";

const up = `
ALTER TABLE clerk_advisory_briefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE clerk_advisory_briefs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_clerk_tenant ON clerk_advisory_briefs;
CREATE POLICY meridian_clerk_tenant ON clerk_advisory_briefs
  USING (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH})
  WITH CHECK (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH});
`;

const down = `
DROP POLICY IF EXISTS meridian_clerk_tenant ON clerk_advisory_briefs;
ALTER TABLE clerk_advisory_briefs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE clerk_advisory_briefs DISABLE ROW LEVEL SECURITY;
`;

export const migration0041 = {
  version: 41,
  name: "advisory_brief_guardrails",
  up,
  down,
};
