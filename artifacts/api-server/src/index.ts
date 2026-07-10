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
    if (policies === 0 || triggers === 0) {
      logger.error(
        { policies, triggers },
        "SECURITY: production tenant-isolation guardrails are MISSING (RLS " +
          "policies / append-only triggers). Provision the production database " +
          "via Replit Publish 'overwrite data' (dev->prod copy) so policies, " +
          "triggers and functions are carried over. Tenant isolation is NOT " +
          "enforced until these exist.",
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
