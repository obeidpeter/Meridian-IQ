import type { Migration } from "./index.ts";

// Migration 0005 — Clerk data-layer guardrails (Clerk Supplemental TRD §5,
// CLK-AI-10, CLK-SEC-03).
//
// Tenant row-level security for the Clerk workflow tables: firm-keyed RLS on
// clerk_cases and clerk_inference_runs, and EXISTS-scoped policies for the
// case children (source artifacts, field candidates, review decisions).
//
// claim_records and clerk_kill_switches are deliberately NOT tenant-keyed:
// claims are counsel-approved platform governance records (like cpd_courses
// and the error catalogue), and kill switches are platform-wide safety
// controls. Both are write-protected by route-level RBAC instead.

const CLERK_TENANT_TABLES = ["clerk_cases", "clerk_inference_runs"];

const FIRM_MATCH =
  "firm_id = nullif(current_setting('app.firm_id', true), '')::uuid";

const SCOPED: { table: string; match: string }[] = [
  {
    table: "clerk_source_artifacts",
    match: `EXISTS (SELECT 1 FROM clerk_cases c WHERE c.id = clerk_source_artifacts.case_id AND c.${FIRM_MATCH})`,
  },
  {
    table: "clerk_field_candidates",
    match: `EXISTS (SELECT 1 FROM clerk_cases c WHERE c.id = clerk_field_candidates.case_id AND c.${FIRM_MATCH})`,
  },
  {
    table: "clerk_review_decisions",
    match: `EXISTS (SELECT 1 FROM clerk_cases c WHERE c.id = clerk_review_decisions.case_id AND c.${FIRM_MATCH})`,
  },
];

const up = `
${CLERK_TENANT_TABLES.map(
  (t) => `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_tenant_isolation ON ${t};
CREATE POLICY meridian_tenant_isolation ON ${t}
  USING (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH})
  WITH CHECK (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH});`,
).join("\n")}

${SCOPED.map(
  ({ table, match }) => `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_tenant_isolation ON ${table};
CREATE POLICY meridian_tenant_isolation ON ${table}
  USING (current_setting('app.bypass', true) = 'on' OR ${match})
  WITH CHECK (current_setting('app.bypass', true) = 'on' OR ${match});`,
).join("\n")}
`;

const ALL_TABLES = [...CLERK_TENANT_TABLES, ...SCOPED.map((s) => s.table)];

const down = `
${ALL_TABLES.map(
  (t) => `DROP POLICY IF EXISTS meridian_tenant_isolation ON ${t};
ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY;
ALTER TABLE ${t} DISABLE ROW LEVEL SECURITY;`,
).join("\n")}
`;

export const migration0005: Migration = {
  version: 5,
  name: "clerk_guardrails",
  up,
  down,
};
