import type pg from "pg";
import { migration0001 } from "./0001_guardrails.ts";
import { migration0002 } from "./0002_r2_guardrails.ts";
import { migration0003 } from "./0003_push_guardrails.ts";
import { migration0004 } from "./0004_fix_retry_mutability.ts";
import { migration0005 } from "./0005_clerk_guardrails.ts";
import { migration0006 } from "./0006_clerk_eval_guardrails.ts";
import { migration0007 } from "./0007_recurring_reminder_guardrails.ts";
import { migration0008 } from "./0008_invitations_guardrails.ts";

export interface Migration {
  version: number;
  name: string;
  up: string;
  down: string;
}

// Ordered forward migrations (CORE-06). Each is applied inside a transaction and
// recorded in `_schema_migrations`; every `up` is idempotent so it can be safely
// re-asserted on boot, and every `down` is reversible (covered by rollback test).
export const migrations: Migration[] = [
  migration0001,
  migration0002,
  migration0003,
  migration0004,
  migration0005,
  migration0006,
  migration0007,
  migration0008,
];

type Executor = Pick<pg.Pool, "query">;

async function ensureTracking(client: Executor): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS _schema_migrations (
      version integer PRIMARY KEY,
      name text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

export async function appliedVersions(client: Executor): Promise<number[]> {
  await ensureTracking(client);
  const res = await client.query(
    "SELECT version FROM _schema_migrations ORDER BY version ASC",
  );
  return res.rows.map((r: { version: number }) => Number(r.version));
}

// Apply all forward migrations. Idempotent: `up` SQL is re-runnable, so this is
// also called on boot to guarantee the guardrails exist.
// Fixed key for the boot-migration advisory lock (CON-L5).
const MIGRATION_LOCK_ID = 991_001;

export async function applyMigrations(pool: pg.Pool): Promise<number[]> {
  await ensureTracking(pool);
  const applied: number[] = [];
  // Hold a session-level advisory lock across the whole apply so two instances
  // booting at once (or a boot racing a `drizzle push`) serialize instead of
  // deadlocking on the self-join delete / CREATE OR REPLACE FUNCTION in the
  // guardrail migrations (CON-L5). The lock spans the per-migration
  // transactions below (session scope, not transaction scope) and auto-releases
  // if the process dies. The waiter finds everything already applied — every
  // `up` is idempotent.
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    for (const m of migrations) {
      try {
        await client.query("BEGIN");
        await client.query(m.up);
        await client.query(
          `INSERT INTO _schema_migrations (version, name) VALUES ($1, $2)
           ON CONFLICT (version) DO UPDATE SET name = EXCLUDED.name`,
          [m.version, m.name],
        );
        await client.query("COMMIT");
        applied.push(m.version);
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      }
    }
  } finally {
    await client
      .query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID])
      .catch(() => {});
    client.release();
  }
  return applied;
}

// Roll back the most recently applied migration (tested by rollback.test.ts).
export async function rollbackLast(pool: pg.Pool): Promise<number | null> {
  await ensureTracking(pool);
  const res = await pool.query(
    "SELECT version FROM _schema_migrations ORDER BY version DESC LIMIT 1",
  );
  const version = res.rows[0]?.version as number | undefined;
  if (version === undefined) return null;
  const m = migrations.find((x) => x.version === Number(version));
  if (!m) return null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(m.down);
    await client.query("DELETE FROM _schema_migrations WHERE version = $1", [
      m.version,
    ]);
    await client.query("COMMIT");
    return m.version;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
