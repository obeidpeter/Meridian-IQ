// Migration 0010 — learning-loop fixture guardrails (Clerk expansion B).
//
// clerk_eval_fixtures holds ground-truth invoice content grown from the
// correction exhaust — cross-tenant document text, exactly the class of data
// 0006 keeps bypass-only on the eval tables. Same posture here: operators and
// platform sweeps (app.bypass='on') only; no firm principal can read another
// firm's corrected documents through the eval corpus. Idempotent `up`,
// reversed by `down` (rollback-test covered).

const up = `
ALTER TABLE clerk_eval_fixtures ENABLE ROW LEVEL SECURITY;
ALTER TABLE clerk_eval_fixtures FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_bypass_only ON clerk_eval_fixtures;
CREATE POLICY meridian_bypass_only ON clerk_eval_fixtures
  USING (current_setting('app.bypass', true) = 'on')
  WITH CHECK (current_setting('app.bypass', true) = 'on');
`;

const down = `
DROP POLICY IF EXISTS meridian_bypass_only ON clerk_eval_fixtures;
ALTER TABLE clerk_eval_fixtures NO FORCE ROW LEVEL SECURITY;
ALTER TABLE clerk_eval_fixtures DISABLE ROW LEVEL SECURITY;
`;

export const migration0010 = {
  version: 10,
  name: "eval_fixture_guardrails",
  up,
  down,
};
