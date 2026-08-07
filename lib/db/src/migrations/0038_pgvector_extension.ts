// pgvector firm memory (Phase 1): the extension itself. Split from the
// table's guardrails (0039) so the extension lands on the FIRST boot after
// this code deploys — before Publish has shipped the embeddings table —
// instead of being skipped along with a missing-relation policy. Idempotent
// (IF NOT EXISTS) like every up. NOTE the failure mode honestly: the DO
// block below converts a missing-binary or permissions error into a pg
// NOTICE the app does not surface, and the migration still records as
// applied — the OPERATOR-VISIBLE signal is the boot check in
// artifacts/api-server/src/index.ts (verifyProductionGuardrails logs the
// extension's absence) plus memoryRailReady()'s runtime feature-detect,
// and the push path fails loudly on the vector column itself.
//
// The down is GUARDED, not unconditional: once `drizzle push` has created
// the vector column, dropping the extension would cascade into data — so a
// rollback with dependents leaves the extension in place (the ladder test
// asserts exactly that).

// TOLERANT up: on a cluster whose postgres lacks the pgvector binary,
// CREATE EXTENSION raises an error whose class is NOT in the boot
// runner's missing-dependency skip list — a bare statement would abort the
// whole apply chain and stop every later migration from landing. The DO
// block downgrades that to a warning; the memory rail feature-detects the
// extension at runtime and stays dark without it.
const up = `
DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'pgvector extension unavailable: %', SQLERRM;
END $$;
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
