// Migration 0018 — chase-log guardrails (round-14 idea #3).
//
// chase_log records which invoices a client has sent payment reminders for —
// tenant data. Same firm-keyed-or-bypass posture as the alias/digest tables:
// a firm principal (including its client_users; SEC-03 narrowing is the
// module's job) reads and writes only its own rows; sweeps and operators run
// with app.bypass='on'. Idempotent `up`, reversed by `down` (rollback-test
// covered).

const FIRM_MATCH =
  "firm_id = nullif(current_setting('app.firm_id', true), '')::uuid";

const up = `
ALTER TABLE chase_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE chase_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_clerk_tenant ON chase_log;
CREATE POLICY meridian_clerk_tenant ON chase_log
  USING (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH})
  WITH CHECK (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH});
`;

const down = `
DROP POLICY IF EXISTS meridian_clerk_tenant ON chase_log;
ALTER TABLE chase_log NO FORCE ROW LEVEL SECURITY;
ALTER TABLE chase_log DISABLE ROW LEVEL SECURITY;
`;

export const migration0018 = {
  version: 18,
  name: "chase_log_guardrails",
  up,
  down,
};
