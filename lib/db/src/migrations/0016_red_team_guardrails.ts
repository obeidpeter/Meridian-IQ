// Migration 0016 — adversarial eval fixture guardrails (Clerk idea #9).
//
// clerk_red_team_fixtures holds model-GENERATED injection documents used to
// red-team extraction — platform eval material with no tenant, exactly the
// class of data 0010 keeps bypass-only on the grown-fixture table. Same
// posture: operators and platform sweeps (app.bypass='on') only. Idempotent
// `up`, reversed by `down` (rollback-test covered).

const up = `
ALTER TABLE clerk_red_team_fixtures ENABLE ROW LEVEL SECURITY;
ALTER TABLE clerk_red_team_fixtures FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_bypass_only ON clerk_red_team_fixtures;
CREATE POLICY meridian_bypass_only ON clerk_red_team_fixtures
  USING (current_setting('app.bypass', true) = 'on')
  WITH CHECK (current_setting('app.bypass', true) = 'on');
`;

const down = `
DROP POLICY IF EXISTS meridian_bypass_only ON clerk_red_team_fixtures;
ALTER TABLE clerk_red_team_fixtures NO FORCE ROW LEVEL SECURITY;
ALTER TABLE clerk_red_team_fixtures DISABLE ROW LEVEL SECURITY;
`;

export const migration0016 = {
  version: 16,
  name: "red_team_guardrails",
  up,
  down,
};
