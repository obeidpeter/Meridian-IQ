// Per-staff client assignment (architecture.md D12): tenant isolation for
// the firm-keyed assignment register. 0001's default privileges grant
// meridian_app full DML on every table, so a firm-keyed table is cross-tenant
// readable the moment `drizzle push` creates it — the policy must land in the
// same release. Firm-keyed like onboarding runs (0037): the register is a
// firm's own view of its book, read by every firm role; it is a convenience
// partition, never a security boundary, so no client-party predicate here.

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

const up = policy("client_assignments");

const down = unpolicy("client_assignments");

export const migration0045 = {
  version: 45,
  name: "client_assignments_guardrails",
  up,
  down,
};
