// Filing Desk (Phase 1): tenant isolation for the statutory returns
// register. 0001's default privileges grant meridian_app full DML on every
// table, so a firm-keyed table is cross-tenant readable the moment `drizzle
// push` creates it — the policy must land in the same release. Firm-keyed
// like the obligations tables (0031): sibling-client isolation inside a firm
// stays a route duty (SEC-03 — narrowToClientPartyScope / the 404
// non-disclosure loader), because firm staff legitimately read the whole
// firm's register. Lifecycle routes update rows in place (upcoming →
// prepared → filed), so no append-only trigger (the 0033 posture, not
// 0030's).

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

const up = policy("filing_returns");

const down = unpolicy("filing_returns");

export const migration0034 = {
  version: 34,
  name: "filing_returns_guardrails",
  up,
  down,
};
