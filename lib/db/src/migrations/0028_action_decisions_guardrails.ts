// Migration 0028 — proposed-actions decision ledger (round 21).
//
// clerk_action_decisions is a firm-keyed tenant table (0018/0026 posture:
// firm principals reach only their own rows; sweeps and operators run with
// app.bypass). One row per HUMAN decision on a Clerk-assembled action batch
// — the durable approval artifact. No purge-function change: the table
// references invoices only inside its jsonb targets (no FK), so invoice
// purges are unaffected and decision history survives them.

const FIRM_MATCH =
  "firm_id = nullif(current_setting('app.firm_id', true), '')::uuid";

const up = `
ALTER TABLE clerk_action_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE clerk_action_decisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_clerk_tenant ON clerk_action_decisions;
CREATE POLICY meridian_clerk_tenant ON clerk_action_decisions
  USING (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH})
  WITH CHECK (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH});
`;

const down = `
DROP POLICY IF EXISTS meridian_clerk_tenant ON clerk_action_decisions;
ALTER TABLE clerk_action_decisions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE clerk_action_decisions DISABLE ROW LEVEL SECURITY;
`;

export const migration0028 = {
  version: 28,
  name: "action_decisions_guardrails",
  up,
  down,
};
