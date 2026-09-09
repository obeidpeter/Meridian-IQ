// Migration 0056 — re-assert the clerk_reservations uniqueness guardrails.
//
// Migration 0053 creates the table with UNIQUE (inference_call_id) and
// UNIQUE (provider_call_id) inline, but only IF NOT EXISTS: a production table
// that the Publish diff created first never received them, and the reviewed
// catalogue comparison then reports the two constraints missing (R113). This
// asserts them idempotently and by COLUMN, not by name: a drizzle push names
// them clerk_reservations_<column>_unique, migration 0053 lets PostgreSQL name
// them clerk_reservations_<column>_key, and the canonical catalogue compares
// definitions rather than names — so any existing single-column unique index
// on the column satisfies the guardrail and nothing is added twice.
//
// The settlement code locks reservation rows FOR UPDATE and never relies on
// ON CONFLICT against these columns, so the constraint is defence in depth:
// one reservation per inference call, enforced by the database rather than by
// application ordering. Duplicate values would make the ALTER fail; the
// explicit check turns that into a named error so a refused boot says which
// column needs attention instead of a bare unique_violation. Boot holds
// readiness (D5) in that case, the intended fail-closed outcome for an
// integrity breach — see the pre-check query in docs/operations.md.
export const migration0056 = {
  version: 56,
  name: "clerk_reservation_uniques",
  up: `
DO $$
DECLARE
  col text;
  attnum_of smallint;
  duplicates bigint;
BEGIN
  FOREACH col IN ARRAY ARRAY['inference_call_id', 'provider_call_id'] LOOP
    SELECT a.attnum INTO attnum_of
      FROM pg_attribute a
     WHERE a.attrelid = 'clerk_reservations'::regclass
       AND a.attname = col
       AND NOT a.attisdropped;
    IF attnum_of IS NULL THEN
      RAISE EXCEPTION 'clerk_reservations.% is missing; apply the reviewed schema before the guardrails', col;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_index i
       WHERE i.indrelid = 'clerk_reservations'::regclass
         AND i.indisunique
         AND i.indnatts = 1
         AND i.indpred IS NULL
         AND i.indkey[0] = attnum_of
    ) THEN
      CONTINUE;
    END IF;
    EXECUTE format(
      'SELECT count(*) FROM (SELECT %I FROM clerk_reservations WHERE %I IS NOT NULL GROUP BY %I HAVING count(*) > 1) d',
      col, col, col
    ) INTO duplicates;
    IF duplicates > 0 THEN
      RAISE EXCEPTION 'clerk_reservations.% carries % duplicated value(s); resolve them before the uniqueness guardrail can be asserted', col, duplicates
        USING ERRCODE = '23505';
    END IF;
    EXECUTE format(
      'ALTER TABLE clerk_reservations ADD CONSTRAINT %I UNIQUE (%I)',
      'clerk_reservations_' || col || '_unique', col
    );
  END LOOP;
END $$;
`,
  // Additive integrity: an older binary is unaffected by the constraints, and
  // removing them would reopen the double-settlement window. Keep them.
  down: `SELECT 1;`,
};
