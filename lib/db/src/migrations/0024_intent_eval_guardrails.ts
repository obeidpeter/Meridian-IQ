// Migration 0024 — intent-eval run guardrails (round 15).
//
// clerk_intent_eval_runs stores the Ask classifier's regression runs —
// operator tooling with no tenant rows, so the same bypass-only posture as
// the extraction eval runs (0006) and red-team fixtures (0016). Idempotent
// `up`, reversed by `down` (rollback-test covered).

const up = `
ALTER TABLE clerk_intent_eval_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE clerk_intent_eval_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_bypass_only ON clerk_intent_eval_runs;
CREATE POLICY meridian_bypass_only ON clerk_intent_eval_runs
  USING (current_setting('app.bypass', true) = 'on')
  WITH CHECK (current_setting('app.bypass', true) = 'on');
`;

const down = `
DROP POLICY IF EXISTS meridian_bypass_only ON clerk_intent_eval_runs;
ALTER TABLE clerk_intent_eval_runs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE clerk_intent_eval_runs DISABLE ROW LEVEL SECURITY;
`;

export const migration0024 = {
  version: 24,
  name: "intent_eval_guardrails",
  up,
  down,
};
