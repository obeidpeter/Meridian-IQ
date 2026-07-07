import app from "./app";
import { pool, applyMigrations } from "@workspace/db";
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

async function main(): Promise<void> {
  // Apply guardrail migrations (append-only triggers, retention, RLS policies)
  // before anything touches the data spine (CORE-06).
  const applied = await applyMigrations(pool);
  logger.info(
    { applied: applied.length },
    applied.length ? "Migrations applied" : "Migrations up to date",
  );
  await seedPlatform();
  startWorker();

  const server = app.listen(port, (err) => {
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
}

main().catch((err) => {
  logger.error({ err }, "Fatal startup error");
  process.exit(1);
});
