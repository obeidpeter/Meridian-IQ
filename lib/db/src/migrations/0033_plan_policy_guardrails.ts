// Do with Clerk Phase 3 (round 33): firm-keyed RLS for clerk_plan_policies —
// the 0029 posture (firm-match or bypass), same as every clerk automation
// table. Deliberately NOT append-only (0030's note): policies are living
// grants the lifecycle routes update in place.

const FIRM_MATCH =
  "firm_id = nullif(current_setting('app.firm_id', true), '')::uuid";

const up = `
ALTER TABLE clerk_plan_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE clerk_plan_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_clerk_tenant ON clerk_plan_policies;
CREATE POLICY meridian_clerk_tenant ON clerk_plan_policies
  USING (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH})
  WITH CHECK (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH});
`;

const down = `
DROP POLICY IF EXISTS meridian_clerk_tenant ON clerk_plan_policies;
ALTER TABLE clerk_plan_policies NO FORCE ROW LEVEL SECURITY;
ALTER TABLE clerk_plan_policies DISABLE ROW LEVEL SECURITY;
`;

export const migration0033 = {
  version: 33,
  name: "plan_policy_guardrails",
  up,
  down,
};
