// Migration 0036 — WHT Desk guardrails.
//
// Two new firm-keyed tables land with this round: `wht_credits` (the
// withholding-tax credit ledger: one row per invoice a buyer actually
// withheld on, walked awaiting_note → note_received with evidence) and
// `wht_reminder_sends` (the at-most-once sent-ledger for its credit-note
// chase reminders, the filing_reminder_sends sibling). Both carry firm_id
// and client_party_id, so without policies here they would be cross-tenant
// readable the moment drizzle push creates them (0001's default privileges
// grant meridian_app full DML on every table). Standard tenant isolation:
// requests see their own firm's rows; sweeps and operators run with
// app.bypass='on'. Sibling-client isolation within a firm stays a
// route-layer duty (SEC-03 — assertClientPartyScope), exactly as for
// invoices — the 0031 two-table precedent.

const FIRM_MATCH =
  "firm_id = nullif(current_setting('app.firm_id', true), '')::uuid";

const policy = (table: string): string => `
ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_tenant_isolation ON ${table};
CREATE POLICY meridian_tenant_isolation ON ${table}
  USING (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH})
  WITH CHECK (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH});
`;

const unpolicy = (table: string): string => `
DROP POLICY IF EXISTS meridian_tenant_isolation ON ${table};
ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY;
ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY;
`;

const up = policy("wht_credits") + policy("wht_reminder_sends");

const down = unpolicy("wht_reminder_sends") + unpolicy("wht_credits");

export const migration0036 = {
  version: 36,
  name: "wht_guardrails",
  up,
  down,
};
