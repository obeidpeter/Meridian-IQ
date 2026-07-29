// Migration 0025 — grown intent fixture guardrails (round 16).
//
// clerk_intent_fixtures stores scrubbed question fixtures for the intent
// eval lane — operator tooling with no tenant reads, same bypass-only
// posture as the runs table (0024). Idempotent `up`, reversed by `down`.

const up = `
ALTER TABLE clerk_intent_fixtures ENABLE ROW LEVEL SECURITY;
ALTER TABLE clerk_intent_fixtures FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_bypass_only ON clerk_intent_fixtures;
CREATE POLICY meridian_bypass_only ON clerk_intent_fixtures
  USING (current_setting('app.bypass', true) = 'on')
  WITH CHECK (current_setting('app.bypass', true) = 'on');
`;

const down = `
DROP POLICY IF EXISTS meridian_bypass_only ON clerk_intent_fixtures;
ALTER TABLE clerk_intent_fixtures NO FORCE ROW LEVEL SECURITY;
ALTER TABLE clerk_intent_fixtures DISABLE ROW LEVEL SECURITY;
`;

export const migration0025 = {
  version: 25,
  name: "intent_fixture_guardrails",
  up,
  down,
};
