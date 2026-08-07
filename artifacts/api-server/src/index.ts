import app from "./app";
import {
  pool,
  applyMigrations,
  applyGuardrailMigrations,
  requireDatabaseUrl,
  ensureAppRoleAssumable,
} from "@workspace/db";
import { logger } from "./lib/logger";
import { startWorker, stopWorker } from "./modules/pipeline/pipeline";
import { seedPlatform } from "./bootstrap/seed";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Apply the hand-written guardrail migrations (RLS policies, append-only
// triggers) to the production database on boot. They are NOT part of the
// Drizzle schema, so Replit's Publish schema-diff never creates them — without
// this, every guardrail added after the one-time dev->prod copy silently never
// reaches production. Safety properties:
//   - every migration `up` is idempotent (re-runnable), and the whole apply is
//     serialized under a session advisory lock, so concurrent Autoscale
//     instances booting at once cannot race;
//   - a guardrail whose target table does not exist yet (Publish has not
//     shipped that feature's schema) is SKIPPED and retried on the next boot,
//     instead of aborting the run;
//   - it runs after app.listen(), never blocks the port, and any failure is
//     logged loudly rather than taking the server down.
async function applyProductionGuardrails(): Promise<void> {
  try {
    const { applied, skipped } = await applyGuardrailMigrations(pool);
    if (skipped.length > 0) {
      logger.warn(
        { skipped },
        "Guardrail migrations skipped (target relation/object missing — " +
          "expected when Publish has not yet created the table; they will " +
          "apply on a boot after that schema ships)",
      );
    }
    logger.info(
      { applied: applied.length, skipped: skipped.length },
      "Production guardrail migrations applied",
    );
  } catch (err) {
    logger.error(
      { err },
      "SECURITY: could not apply guardrail migrations to production; " +
        "RLS/append-only protections may be missing or stale. Fix the error " +
        "or run `pnpm --filter @workspace/db run migrate` with the production " +
        "DATABASE_URL.",
    );
  }
}

// Read-only check that the data-layer tenant-isolation guardrails are present in
// production. RLS policies (meridian_tenant_isolation) and append-only triggers
// (meridian_append_only) live in hand-written migrations (0001/0002), not the
// Drizzle schema, so Replit's Publish schema-diff does NOT create them; the boot
// step above (applyProductionGuardrails) is what applies them. This check never
// blocks startup or the port; it only surfaces a missing guardrail loudly in the
// deployment logs so tenant isolation is never silently absent.
async function verifyProductionGuardrails(): Promise<void> {
  try {
    const { rows } = await pool.query(
      `SELECT
         (SELECT count(*) FROM pg_policies
            WHERE schemaname = 'public'
              AND policyname = 'meridian_tenant_isolation') AS policies,
         (SELECT count(*) FROM pg_trigger
            WHERE tgname = 'meridian_append_only' AND NOT tgisinternal) AS triggers`,
    );
    const policies = Number(rows[0]?.policies ?? 0);
    const triggers = Number(rows[0]?.triggers ?? 0);
    // Coverage sweep (read-only): any tenant-keyed table (firm_id /
    // client_party_id / party_id column) without forced RLS + a policy is a
    // gap the CI rls-coverage test would fail on — surface the specific
    // tables here so a production database that predates a guardrail
    // migration (e.g. 0013) reports exactly what is missing. audit_events is
    // the one documented exemption (global hash chain; migration 0013 header).
    const uncoveredRes = await pool.query(
      `SELECT c.table_name
       FROM (SELECT DISTINCT col.table_name
               FROM information_schema.columns col
               JOIN information_schema.tables t
                 ON t.table_name = col.table_name AND t.table_schema = 'public'
              WHERE col.table_schema = 'public'
                AND t.table_type = 'BASE TABLE'
                AND col.column_name IN ('firm_id', 'client_party_id', 'party_id')) c
       JOIN pg_class k ON k.relname = c.table_name
       JOIN pg_namespace n ON n.oid = k.relnamespace AND n.nspname = 'public'
       WHERE NOT (k.relrowsecurity AND k.relforcerowsecurity)
          OR NOT EXISTS (SELECT 1 FROM pg_policies p
                           WHERE p.schemaname = 'public'
                             AND p.tablename = c.table_name)
       ORDER BY c.table_name`,
    );
    const uncovered = (uncoveredRes.rows as { table_name: string }[])
      .map((r) => r.table_name)
      .filter((t) => t !== "audit_events");
    // pgvector presence (round 45): migration 0038's tolerant DO block
    // downgrades a missing-extension error to a pg NOTICE nothing surfaces,
    // so THIS is the operator-visible signal. Not a security gap — the
    // memory rail feature-detects and stays dark — but a silently-absent
    // extension would otherwise read as "memory just never indexes".
    const extRes = await pool.query(
      "SELECT 1 FROM pg_extension WHERE extname = 'vector' LIMIT 1",
    );
    if (extRes.rowCount === 0) {
      logger.warn(
        "pgvector extension is not installed on this database; the Clerk " +
          "firm-memory rail stays dark until the cluster provides it " +
          "(migration 0038 could not create it).",
      );
    }
    if (policies === 0 || triggers === 0 || uncovered.length > 0) {
      logger.error(
        { policies, triggers, uncovered },
        "SECURITY: production tenant-isolation guardrails are MISSING or " +
          "incomplete (RLS policies / append-only triggers / uncovered " +
          "tenant-keyed tables listed above). Apply the guardrail migrations " +
          "to this database (pnpm --filter @workspace/db run migrate with the " +
          "production DATABASE_URL, or a Publish dev->prod copy). Tenant " +
          "isolation is NOT fully enforced at the data layer until this is " +
          "clean.",
      );
    } else {
      logger.info({ policies, triggers }, "Production guardrails verified");
    }
  } catch (err) {
    logger.error({ err }, "Could not verify production guardrails");
  }
}

// Repair the login role's ability to assume the restricted RLS role at startup.
// See ensureAppRoleAssumable() in @workspace/db for why this is required in a
// deployment (non-superuser login missing the PG16 SET membership option) and a
// no-op in development. Never throws: a failure is logged loudly so a broken RLS
// role surfaces in the deployment logs instead of taking the server down.
async function ensureRlsRoleAssumable(): Promise<void> {
  try {
    const status = await ensureAppRoleAssumable();
    if (status === "granted") {
      logger.warn(
        "Granted the login role the SET privilege on meridian_app; the RLS " +
          "role is now assumable (SET ROLE meridian_app will succeed).",
      );
    } else if (status === "already-assumable") {
      logger.info("RLS role meridian_app is assumable");
    } else if (status === "role-missing") {
      logger.error(
        "SECURITY: role meridian_app is MISSING, so SET ROLE will fail and no " +
          "tenant-scoped request can run. Provision the production database via " +
          "Replit Publish 'overwrite data' (dev->prod copy).",
      );
    } else {
      logger.error(
        "SECURITY: could not obtain the SET privilege on meridian_app; SET ROLE " +
          "will keep failing. The login role needs ADMIN on meridian_app.",
      );
    }
  } catch (err) {
    logger.error(
      { err },
      "Could not ensure the RLS role is assumable; SET ROLE meridian_app may fail",
    );
  }
}

async function main(): Promise<void> {
  // Fail fast on a missing database before serving anything (the pool itself
  // is lazy so that pure-function tests can import the schema without a DB).
  requireDatabaseUrl();

  // Open the port FIRST. Nothing before app.listen() may block on the database:
  // the liveness probe (/api/healthz) does not touch the DB, so the artifact can
  // promote even while the database is still warming up or briefly unreachable.
  // Previously app.listen() was gated behind applyMigrations()/seedPlatform(), so
  // a slow or hanging database connection at boot meant the port never opened and
  // the publish failed with "required port was never opened".
  const server = app.listen(port, (err?: Error) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }
    logger.info({ port }, "Server listening");
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, "Shutting down");
    stopWorker();
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  const isProduction = process.env.NODE_ENV === "production";

  // Before anything assumes the restricted RLS role, make sure the login role can
  // actually `SET ROLE meridian_app` (both requests and the worker depend on it).
  // In production the non-superuser login is a member of meridian_app but lacks
  // the PG16 "SET" membership option, so this repair is what makes login work at
  // all; in development the superuser login already can, so it is a no-op. Done
  // before startWorker() so the first worker loop can enter its bypass context.
  if (isProduction) {
    await ensureRlsRoleAssumable();
  }

  // In-process polling worker. Every loop is unref'd and swallows its own errors,
  // so it is safe to start before the database is confirmed reachable.
  startWorker();

  // Schema and seed data for PRODUCTION are owned by Replit's Publish flow (the
  // schema diff applied on publish) — NOT by the application, so demo seeding and
  // the full dev bootstrap only run outside production. The one exception is the
  // hand-written guardrail migrations (RLS, append-only triggers): Publish cannot
  // create those, so production applies them idempotently on boot below.
  if (!isProduction) {
    try {
      const applied = await applyMigrations(pool);
      logger.info(
        { applied: applied.length },
        applied.length ? "Migrations applied" : "Migrations up to date",
      );
      await seedPlatform();
    } catch (err) {
      logger.error({ err }, "Bootstrap (migrate/seed) failed");
    }
  } else {
    // Apply the guardrail migrations first (idempotent, advisory-locked), then
    // run the read-only verification so the deploy logs state the final truth.
    void applyProductionGuardrails().then(() => verifyProductionGuardrails());
  }
}

main().catch((err) => {
  logger.error({ err }, "Fatal startup error");
  process.exit(1);
});
