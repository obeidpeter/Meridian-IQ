// Migration 0040 — retrieval eval run guardrails (round 47).
//
// clerk_retrieval_eval_runs stores the embedding-retrieval eval runs
// (recall@k / MRR over the fixed labeled corpus) — operator tooling with no
// tenant reads, same bypass-only posture as the intent-eval (0024) and
// phrasing-eval (0027) run tables. Idempotent `up`, reversed by `down`.

const up = `
ALTER TABLE clerk_retrieval_eval_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE clerk_retrieval_eval_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_bypass_only ON clerk_retrieval_eval_runs;
CREATE POLICY meridian_bypass_only ON clerk_retrieval_eval_runs
  USING (current_setting('app.bypass', true) = 'on')
  WITH CHECK (current_setting('app.bypass', true) = 'on');
`;

const down = `
DROP POLICY IF EXISTS meridian_bypass_only ON clerk_retrieval_eval_runs;
ALTER TABLE clerk_retrieval_eval_runs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE clerk_retrieval_eval_runs DISABLE ROW LEVEL SECURITY;
`;

export const migration0040 = {
  version: 40,
  name: "retrieval_eval_guardrails",
  up,
  down,
};
