import type pg from "pg";
import { migration0001 } from "./0001_guardrails";

export interface Migration {
  version: number;
  name: string;
  up: string;
  down: string;
}

// Ordered forward migrations (CORE-06). Each is applied inside a transaction and
// recorded in `_schema_migrations`; every `up` is idempotent so it can be safely
// re-asserted on boot, and every `down` is reversible (covered by rollback test).
export const migrations: Migration[] = [migration0001];

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
export async function applyMigrations(pool: pg.Pool): Promise<number[]> {
  await ensureTracking(pool);
  const applied: number[] = [];
  for (const m of migrations) {
    const client = await pool.connect();
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
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
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
