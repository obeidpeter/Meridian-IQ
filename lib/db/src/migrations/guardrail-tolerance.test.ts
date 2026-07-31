import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { applyGuardrailMigrations, type Migration } from "./index.ts";

// Task: guardrail migrations must reach production on boot. Production applies
// them via applyGuardrailMigrations(), which — unlike applyMigrations() — must
// SKIP (not abort on) a migration whose target relation does not exist yet
// (Publish hasn't shipped that feature's schema), while still applying every
// other migration and still throwing on genuine errors.

function makePool(): pg.Pool {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set to run migration tests");
  }
  return new pg.Pool({ connectionString: process.env.DATABASE_URL });
}

// Versions far above the real registry so tracking rows never collide.
const V_OK = 990_101;
const V_MISSING = 990_102;
const V_AFTER = 990_103;

async function cleanup(pool: pg.Pool): Promise<void> {
  await pool.query(
    "DELETE FROM _schema_migrations WHERE version IN ($1, $2, $3)",
    [V_OK, V_MISSING, V_AFTER],
  );
  await pool.query("DROP TABLE IF EXISTS _guardrail_tolerance_probe");
}

test("applyGuardrailMigrations skips missing-relation migrations and applies the rest", async () => {
  const pool = makePool();
  try {
    await cleanup(pool);
    const list: Migration[] = [
      {
        version: V_OK,
        name: "tolerance_probe_ok",
        up: "CREATE TABLE IF NOT EXISTS _guardrail_tolerance_probe (id int)",
        down: "DROP TABLE IF EXISTS _guardrail_tolerance_probe",
      },
      {
        version: V_MISSING,
        name: "tolerance_probe_missing_table",
        // Trigger on a table that does not exist -> 42P01, must be skipped.
        up: `CREATE TRIGGER meridian_append_only BEFORE UPDATE OR DELETE
             ON _guardrail_no_such_table
             FOR EACH ROW EXECUTE FUNCTION meridian_block_mutations();`,
        down: "SELECT 1",
      },
      {
        version: V_AFTER,
        name: "tolerance_probe_after_skip",
        up: "SELECT 1",
        down: "SELECT 1",
      },
    ];

    const result = await applyGuardrailMigrations(pool, list);
    assert.deepEqual(result.applied, [V_OK, V_AFTER]);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0]!.version, V_MISSING);
    assert.equal(result.skipped[0]!.code, "42P01");

    // Skipped migration is NOT recorded, so it stays pending for a later boot.
    const tracked = await pool.query(
      "SELECT version FROM _schema_migrations WHERE version IN ($1,$2,$3) ORDER BY version",
      [V_OK, V_MISSING, V_AFTER],
    );
    assert.deepEqual(
      tracked.rows.map((r: { version: number }) => Number(r.version)),
      [V_OK, V_AFTER],
    );

    // A genuine error (not a missing dependency) must still throw.
    await assert.rejects(
      applyGuardrailMigrations(pool, [
        {
          version: V_AFTER,
          name: "tolerance_probe_syntax_error",
          up: "THIS IS NOT SQL",
          down: "SELECT 1",
        },
      ]),
    );
  } finally {
    await cleanup(pool).catch(() => {});
    await pool.end();
  }
});
