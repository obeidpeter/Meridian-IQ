import app from "./app";
import {
  pool,
  applyMigrations,
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

// Read-only check that the data-layer tenant-isolation guardrails are present in
// production. RLS policies (meridian_tenant_isolation) and append-only triggers
// (meridian_append_only) live in hand-written migrations (0001/0002), not the
// Drizzle schema, so Replit's Publish schema-diff does NOT create them. A
// production database is expected to carry them via the Publish "overwrite data"
// dev->prod copy. This never blocks startup or the port; it only surfaces a
// missing guardrail loudly in the deployment logs so tenant isolation is never
// silently absent.
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
  // schema diff applied on publish) and the one-time dev->prod data copy — NOT by
  // the application. Running startup-time DDL migrations or demo seeding against
  // production is unsafe (and disallowed), so bootstrap only runs outside
  // production. It is wrapped so a failure is logged without taking the server
  // down or blocking the port.
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
    void verifyProductionGuardrails();
  }
}

main().catch((err) => {
  logger.error({ err }, "Fatal startup error");
  process.exit(1);
});
