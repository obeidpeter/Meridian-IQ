// Migration 0031 — Notice Desk obligations guardrails.
//
// Two new firm-keyed tables land with this round: `obligations` (a confirmed
// tax-authority notice: the client, the authority, the response deadline) and
// `obligation_reminder_sends` (the at-most-once sent-ledger for its deadline
// reminders, the deadline_reminder_sends sibling). Both carry firm_id and
// client_party_id, so without policies here they would be cross-tenant
// readable the moment drizzle push creates them (0001's default privileges
// grant meridian_app full DML on every table). Standard tenant isolation:
// requests see their own firm's rows; sweeps and operators run with
// app.bypass='on'. Sibling-client isolation within a firm stays a route-layer
// duty (SEC-03 — assertClientPartyScope), exactly as for invoices.

const FIRM_MATCH =
  "firm_id = nullif(current_setting('app.firm_id', true), '')::uuid";

const policy = (table: string) => `
ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_tenant_isolation ON ${table};
CREATE POLICY meridian_tenant_isolation ON ${table}
  USING (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH})
  WITH CHECK (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH});
`;

const unpolicy = (table: string) => `
DROP POLICY IF EXISTS meridian_tenant_isolation ON ${table};
ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY;
ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY;
`;

const up = policy("obligations") + policy("obligation_reminder_sends");

const down = unpolicy("obligation_reminder_sends") + unpolicy("obligations");

export const migration0031 = {
  version: 31,
  name: "obligations_guardrails",
  up,
  down,
};
