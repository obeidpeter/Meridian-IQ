import type pg from "pg";
import { migration0001 } from "./0001_guardrails.ts";
import { migration0002 } from "./0002_r2_guardrails.ts";
import { migration0003 } from "./0003_push_guardrails.ts";
import { migration0004 } from "./0004_fix_retry_mutability.ts";
import { migration0005 } from "./0005_clerk_guardrails.ts";
import { migration0006 } from "./0006_clerk_eval_guardrails.ts";
import { migration0007 } from "./0007_recurring_reminder_guardrails.ts";
import { migration0008 } from "./0008_invitations_guardrails.ts";
import { migration0009 } from "./0009_clerk_tenant_read.ts";
import { migration0010 } from "./0010_eval_fixture_guardrails.ts";
import { migration0011 } from "./0011_digest_guardrails.ts";
import { migration0012 } from "./0012_password_reset_guardrails.ts";
import { migration0013 } from "./0013_tenant_coverage_guardrails.ts";
import { migration0014 } from "./0014_batch_guardrails.ts";
import { migration0015 } from "./0015_client_statement_guardrails.ts";
import { migration0016 } from "./0016_red_team_guardrails.ts";
import { migration0017 } from "./0017_party_alias_guardrails.ts";
import { migration0018 } from "./0018_chase_log_guardrails.ts";
import { migration0019 } from "./0019_staff_notification_prefs_guardrails.ts";
import { migration0020 } from "./0020_statement_feed_guardrails.ts";
import { migration0021 } from "./0021_payment_intent_guardrails.ts";
import { migration0022 } from "./0022_integrations_guardrails.ts";
import { migration0023 } from "./0023_bill_verification_guardrails.ts";
import { migration0024 } from "./0024_intent_eval_guardrails.ts";
import { migration0025 } from "./0025_intent_fixture_guardrails.ts";
import { migration0026 } from "./0026_governance_collections_guardrails.ts";
import { migration0027 } from "./0027_phrasing_eval_guardrails.ts";
import { migration0028 } from "./0028_action_decisions_guardrails.ts";
import { migration0029 } from "./0029_action_policies_guardrails.ts";
import { migration0030 } from "./0030_action_decision_ledger_guardrails.ts";
import { migration0031 } from "./0031_obligations_guardrails.ts";
import { migration0032 } from "./0032_plan_run_guardrails.ts";
import { migration0033 } from "./0033_plan_policy_guardrails.ts";
import { migration0034 } from "./0034_filing_returns_guardrails.ts";
import { migration0035 } from "./0035_filing_reminder_guardrails.ts";

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
  migration0009,
  migration0010,
  migration0011,
  migration0012,
  migration0013,
  migration0014,
  migration0015,
  migration0016,
  migration0017,
  migration0018,
  migration0019,
  migration0020,
  migration0021,
  migration0022,
  migration0023,
  migration0024,
  migration0025,
  migration0026,
  migration0027,
  migration0028,
  migration0029,
  migration0030,
  migration0031,
  migration0032,
  migration0033,
  migration0034,
  migration0035,
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
  const { applied } = await applyMigrationsInternal(pool, false);
  return applied;
}

export interface SkippedMigration {
  version: number;
  name: string;
  code: string;
  message: string;
}

export interface GuardrailApplyResult {
  applied: number[];
  skipped: SkippedMigration[];
}

// Prod-boot variant of applyMigrations: a migration whose target relation/object
// does not exist yet (because Replit's Publish schema-diff has not created the
// table this guardrail attaches to) is SKIPPED — rolled back, NOT recorded in
// _schema_migrations, and reported — instead of aborting the whole run. On a
// later boot, once Publish has created the table, the still-pending guardrail
// applies. Any other error still throws: a guardrail failing for a reason other
// than a missing dependency must be loud, not swallowed.
const MISSING_DEPENDENCY_CODES = new Set([
  "42P01", // undefined_table
  "42703", // undefined_column
  "42704", // undefined_object
  "3F000", // invalid_schema_name
]);

export async function applyGuardrailMigrations(
  pool: pg.Pool,
  migrationList: Migration[] = migrations, // injectable for tests only
): Promise<GuardrailApplyResult> {
  return applyMigrationsInternal(pool, true, migrationList);
}

async function applyMigrationsInternal(
  pool: pg.Pool,
  tolerateMissingDependencies: boolean,
  migrationList: Migration[] = migrations,
): Promise<GuardrailApplyResult> {
  await ensureTracking(pool);
  const applied: number[] = [];
  const skipped: SkippedMigration[] = [];
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
    for (const m of migrationList) {
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
        const code = (err as { code?: string }).code ?? "";
        if (tolerateMissingDependencies && MISSING_DEPENDENCY_CODES.has(code)) {
          skipped.push({
            version: m.version,
            name: m.name,
            code,
            message: (err as Error).message,
          });
          continue;
        }
        throw err;
      }
    }
  } finally {
    await client
      .query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID])
      .catch(() => {});
    client.release();
  }
  return { applied, skipped };
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
