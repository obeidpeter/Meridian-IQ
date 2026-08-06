// Filing Desk Phase 2: tenant isolation for the filing reminder ledger —
// the same firm-keyed posture as 0034's register (and 0031's obligation
// sends ledger): a firm-keyed table is cross-tenant readable the moment
// `drizzle push` creates it, so the policy lands in the same release.

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

const up = policy("filing_reminder_sends");

const down = unpolicy("filing_reminder_sends");

export const migration0035 = {
  version: 35,
  name: "filing_reminder_guardrails",
  up,
  down,
};
