// Migration 0029 — standing-approval policies (round 28).
//
// clerk_action_policies is a firm-keyed tenant table (0018/0026 posture:
// firm principals reach only their own rows; the daily sweep and operators
// run with app.bypass). One row per GRANT of a standing approval — the
// durable authorization artifact the sweep re-validates on every run.
// Revoked rows are permanent evidence (the live-uniqueness rule lives in
// the schema's partial unique index, not here). No purge-function change:
// the table references no invoices, so purges are unaffected.

const FIRM_MATCH =
  "firm_id = nullif(current_setting('app.firm_id', true), '')::uuid";

const up = `
ALTER TABLE clerk_action_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE clerk_action_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_clerk_tenant ON clerk_action_policies;
CREATE POLICY meridian_clerk_tenant ON clerk_action_policies
  USING (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH})
  WITH CHECK (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH});
`;

const down = `
DROP POLICY IF EXISTS meridian_clerk_tenant ON clerk_action_policies;
ALTER TABLE clerk_action_policies NO FORCE ROW LEVEL SECURITY;
ALTER TABLE clerk_action_policies DISABLE ROW LEVEL SECURITY;
`;

export const migration0029 = {
  version: 29,
  name: "action_policies_guardrails",
  up,
  down,
};
