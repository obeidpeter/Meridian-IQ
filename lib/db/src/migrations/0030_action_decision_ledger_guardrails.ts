// Migration 0030 — action-decision ledger immutability (review fix F3).
//
// clerk_action_decisions is the artifact that answers "who authorized this
// filing" — decidedBy, policyId, pre-execution evidence and per-target
// outcomes. Every sibling Clerk evidence table (clerk_inference_calls 0005,
// clerk_eval_runs 0006) blocks UPDATE/DELETE with the shared
// meridian_block_mutations trigger (from 0001); this one shipped without it,
// leaving the app role free to rewrite history with only the audit_events
// pointer row as an indirect witness. No code path mutates decision rows, so
// the trigger changes nothing for correct code — it makes the ledger
// tamper-evident at the data layer.
//
// clerk_action_policies is deliberately NOT covered: pause/resume/revoke and
// the last_run_day CAS are legitimate in-place lifecycle writes.

const up = `
DROP TRIGGER IF EXISTS meridian_append_only ON clerk_action_decisions;
CREATE TRIGGER meridian_append_only BEFORE UPDATE OR DELETE ON clerk_action_decisions
  FOR EACH ROW EXECUTE FUNCTION meridian_block_mutations();
`;

const down = `
DROP TRIGGER IF EXISTS meridian_append_only ON clerk_action_decisions;
`;

export const migration0030 = {
  version: 30,
  name: "action_decision_ledger_guardrails",
  up,
  down,
};
