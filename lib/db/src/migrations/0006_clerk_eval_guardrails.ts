// Migration 0006 — Clerk evaluation-run guardrails (§13.1).
//
// clerk_eval_runs is Readiness-Review evidence: an operator-triggered pass of
// the synthetic fixture corpus through the live gateway, scored per field.
// Evidence records are append-only (the shared meridian_block_mutations
// trigger from migration 0001 blocks UPDATE/DELETE), and the table is RLS'd
// bypass-only like the other Clerk tables — operator/auditor/system sessions
// only, never firm-scoped ones. Fixture content is synthetic C1 by design,
// but run results reveal model/prompt behaviour, which is operator material.
//
// Idempotent so it can be re-asserted on boot; `down` fully reverses it.

const up = `
DROP TRIGGER IF EXISTS meridian_append_only ON clerk_eval_runs;
CREATE TRIGGER meridian_append_only BEFORE UPDATE OR DELETE ON clerk_eval_runs
  FOR EACH ROW EXECUTE FUNCTION meridian_block_mutations();

ALTER TABLE clerk_eval_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE clerk_eval_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_bypass_only ON clerk_eval_runs;
CREATE POLICY meridian_bypass_only ON clerk_eval_runs
  USING (current_setting('app.bypass', true) = 'on')
  WITH CHECK (current_setting('app.bypass', true) = 'on');
`;

const down = `
DROP POLICY IF EXISTS meridian_bypass_only ON clerk_eval_runs;
ALTER TABLE clerk_eval_runs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE clerk_eval_runs DISABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS meridian_append_only ON clerk_eval_runs;
`;

export const migration0006 = {
  version: 6,
  name: "clerk_eval_guardrails",
  up,
  down,
};
