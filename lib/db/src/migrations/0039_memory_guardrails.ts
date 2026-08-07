// pgvector firm memory (Phase 1): tenant isolation for the embeddings
// table. 0001's default privileges grant meridian_app full DML on every
// table, so a firm-keyed table is cross-tenant readable the moment `drizzle
// push` creates it — the policy must land in the same release. Clerk-family
// policy name (meridian_clerk_tenant, the 0014/0032 posture): the indexer
// sweep writes under bypass, retrieval runs inside the caller's firm scope.
// Rows update in place (content-hash refresh), so no append-only trigger.

const FIRM_MATCH =
  "firm_id = nullif(current_setting('app.firm_id', true), '')::uuid";

const policy = (table: string): string => `
ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_clerk_tenant ON ${table};
CREATE POLICY meridian_clerk_tenant ON ${table}
  USING (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH})
  WITH CHECK (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH});
`;

const unpolicy = (table: string): string => `
DROP POLICY IF EXISTS meridian_clerk_tenant ON ${table};
ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY;
ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY;
`;

const up = policy("clerk_memory_embeddings");

const down = unpolicy("clerk_memory_embeddings");

export const migration0039 = {
  version: 39,
  name: "memory_guardrails",
  up,
  down,
};
