// Migration 0037 — Client Compliance Profile guardrails.
//
// One new firm-keyed table lands with this round: `client_compliance_profiles`
// (the per-client statutory facts a firm asserts — VAT registration, PAYE
// employer status, financial year end, incorporation date — that gate the
// Filing Desk's minting and unlock the annual return kinds). It carries
// firm_id and client_party_id, so without a policy here it would be
// cross-tenant readable the moment drizzle push creates it (0001's default
// privileges grant meridian_app full DML on every table). Standard tenant
// isolation: requests see their own firm's rows; sweeps and operators run
// with app.bypass='on'. Sibling-client isolation within a firm stays a
// route-layer duty (SEC-03 — assertClientPartyScope), exactly as for
// invoices.

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

const up = policy("client_compliance_profiles");

const down = unpolicy("client_compliance_profiles");

export const migration0037 = {
  version: 37,
  name: "compliance_profile_guardrails",
  up,
  down,
};
