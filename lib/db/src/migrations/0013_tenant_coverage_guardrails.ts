// Migration 0013 — tenant-coverage guardrails (SEC-02 defense in depth).
//
// Closes the RLS coverage gap found by the architecture review: these tables
// carry firm- or party-keyed tenant data but had NO policy at all, so route
// guards were their only isolation — one forgotten filter would have been a
// cross-tenant leak with no data-layer backstop (0001's default privileges
// grant meridian_app full DML on every table, making "new table =
// cross-tenant readable" the default state). The rls-coverage test now
// enumerates tenant-keyed tables and fails CI when a table ships without a
// policy, so this drift class cannot recur silently.
//
// Postures, matched to each table's actual access paths:
//  - Firm-keyed-or-bypass (the 0001 pattern): rows carry firm_id; firm
//    principals see their own, cross-tenant staff and sweeps run bypass.
//    memberships.firm_id is nullable (platform roles) — NULL never matches
//    the firm GUC, so operator memberships are invisible to firm principals,
//    which is exactly right; principal resolution reads memberships on the
//    raw pool BEFORE any context and is unaffected.
//  - firms: the tenant key IS the primary key, so the match is id = GUC.
//    Every firm-context read of firms targets the principal's own firm
//    (branding, invitations); operators/public-theme resolution run bypass.
//  - Party-scoped via engagements: alert_preferences (client contact PII)
//    and consent_records are keyed by party, not firm — a firm may reach
//    exactly the parties it engages (the same linkage the routes enforce
//    with assertPartyAccess). The EXISTS probe reads engagements, itself
//    RLS'd firm-keyed by 0001, which narrows the probe to the caller's own
//    engagements — the same recursive-policy pattern 0001 uses for
//    invoice-scoped children.
//
// Deliberately NOT covered here (documented allowlist in rls-coverage.test):
//  - audit_events: appendAudit runs inside every tenant transaction and must
//    both INSERT and read the chain tail (ORDER BY seq) regardless of tenant;
//    scoping it means per-firm chains — a planned redesign, not a policy.
//    Integrity is protected by the append-only trigger; reads are gated to
//    operator/auditor at the route layer.
//
// Idempotent `up`, fully reversed by `down` (rollback-test covered).

const FIRM_TABLES = [
  "escalations",
  "firm_subscriptions",
  "memberships",
  "onboarding_prospects",
  "operator_cases",
  "revenue_share_statements",
];

const BYPASS = "current_setting('app.bypass', true) = 'on'";
const FIRM_GUC = "nullif(current_setting('app.firm_id', true), '')::uuid";
const FIRM_MATCH = `firm_id = ${FIRM_GUC}`;

// Party-keyed tables: the firm reaches exactly the parties it engages.
const PARTY_SCOPED: { table: string; partyColumn: string }[] = [
  { table: "alert_preferences", partyColumn: "client_party_id" },
  { table: "consent_records", partyColumn: "party_id" },
];

function partyMatch(t: { table: string; partyColumn: string }): string {
  return `EXISTS (
    SELECT 1 FROM engagements e
    WHERE e.client_party_id = ${t.table}.${t.partyColumn}
      AND e.firm_id = ${FIRM_GUC}
  )`;
}

const up = `
${FIRM_TABLES.map(
  (t) => `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_tenant_isolation ON ${t};
CREATE POLICY meridian_tenant_isolation ON ${t}
  USING (${BYPASS} OR ${FIRM_MATCH})
  WITH CHECK (${BYPASS} OR ${FIRM_MATCH});`,
).join("\n")}

ALTER TABLE firms ENABLE ROW LEVEL SECURITY;
ALTER TABLE firms FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_tenant_isolation ON firms;
CREATE POLICY meridian_tenant_isolation ON firms
  USING (${BYPASS} OR id = ${FIRM_GUC})
  WITH CHECK (${BYPASS} OR id = ${FIRM_GUC});

${PARTY_SCOPED.map(
  (t) => `ALTER TABLE ${t.table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${t.table} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_tenant_isolation ON ${t.table};
CREATE POLICY meridian_tenant_isolation ON ${t.table}
  USING (${BYPASS} OR ${partyMatch(t)})
  WITH CHECK (${BYPASS} OR ${partyMatch(t)});`,
).join("\n")}
`;

const ALL_TABLES = [...FIRM_TABLES, "firms", ...PARTY_SCOPED.map((t) => t.table)];

const down = `
${ALL_TABLES.map(
  (t) => `DROP POLICY IF EXISTS meridian_tenant_isolation ON ${t};
ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY;
ALTER TABLE ${t} DISABLE ROW LEVEL SECURITY;`,
).join("\n")}
`;

export const migration0013 = {
  version: 13,
  name: "tenant_coverage_guardrails",
  up,
  down,
};
