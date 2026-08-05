// Do with Clerk Phase 2 (round 32): firm-keyed RLS for clerk_plan_runs —
// the 0009 Clerk posture (firm-match or bypass), same as clerk_batches
// (0014). Sub-tenant narrowing (a client_user sees only runs it approved)
// is route-layer via approved_by, not RLS — the 0014 precedent.

const FIRM_MATCH =
  "firm_id = nullif(current_setting('app.firm_id', true), '')::uuid";

const up = `
ALTER TABLE clerk_plan_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE clerk_plan_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_clerk_tenant ON clerk_plan_runs;
CREATE POLICY meridian_clerk_tenant ON clerk_plan_runs
  USING (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH})
  WITH CHECK (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH});
`;

const down = `
DROP POLICY IF EXISTS meridian_clerk_tenant ON clerk_plan_runs;
ALTER TABLE clerk_plan_runs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE clerk_plan_runs DISABLE ROW LEVEL SECURITY;
`;

export const migration0032 = {
  version: 32,
  name: "plan_run_guardrails",
  up,
  down,
};
