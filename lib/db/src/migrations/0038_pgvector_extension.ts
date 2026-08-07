// pgvector firm memory (Phase 1): the extension itself. Split from the
// table's guardrails (0039) so the extension lands on the FIRST boot after
// this code deploys — before Publish has shipped the embeddings table —
// instead of being skipped along with a missing-relation policy. Idempotent
// (IF NOT EXISTS) like every up; on a cluster whose postgres lacks the
// pgvector binary the error surfaces in applyGuardrailMigrations' loud
// logging and the memory rail stays dark (the flag never lights without
// the schema converging).
//
// The down is GUARDED, not unconditional: once `drizzle push` has created
// the vector column, dropping the extension would cascade into data — so a
// rollback with dependents leaves the extension in place (the ladder test
// asserts exactly that).

const up = `
CREATE EXTENSION IF NOT EXISTS vector;
`;

const down = `
DO $$ BEGIN
  DROP EXTENSION IF EXISTS vector RESTRICT;
EXCEPTION WHEN dependent_objects_still_exist THEN
  NULL;
END $$;
`;

export const migration0038 = {
  version: 38,
  name: "pgvector_extension",
  up,
  down,
};
