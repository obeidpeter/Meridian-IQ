// Migration 0027 — phrasing eval run guardrails (round 18).
//
// clerk_phrasing_eval_runs stores the digest/chaser phrasing eval runs —
// operator tooling with no tenant reads, same bypass-only posture as the
// intent-eval runs (0024) and grown fixtures (0025). Idempotent `up`,
// reversed by `down`.

const up = `
ALTER TABLE clerk_phrasing_eval_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE clerk_phrasing_eval_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_bypass_only ON clerk_phrasing_eval_runs;
CREATE POLICY meridian_bypass_only ON clerk_phrasing_eval_runs
  USING (current_setting('app.bypass', true) = 'on')
  WITH CHECK (current_setting('app.bypass', true) = 'on');
`;

const down = `
DROP POLICY IF EXISTS meridian_bypass_only ON clerk_phrasing_eval_runs;
ALTER TABLE clerk_phrasing_eval_runs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE clerk_phrasing_eval_runs DISABLE ROW LEVEL SECURITY;
`;

export const migration0027 = {
  version: 27,
  name: "phrasing_eval_guardrails",
  up,
  down,
};
