// Onboard with Clerk (Phase 1): tenant isolation for the client onboarding
// runs. 0001's default privileges grant meridian_app full DML on every
// table, so a firm-keyed table is cross-tenant readable the moment `drizzle
// push` creates it — the policy must land in the same release. Firm-keyed
// like the filings register (0034): sibling-client isolation inside a firm
// stays a route duty (SEC-03 — narrowToClientPartyScope on reads), because
// firm staff legitimately read every client's onboarding progress. Rows
// update in place (detection refresh, skips, terminal CAS), so no
// append-only trigger.

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

const up = policy("client_onboarding_runs");

const down = unpolicy("client_onboarding_runs");

export const migration0037 = {
  version: 37,
  name: "onboarding_guardrails",
  up,
  down,
};
