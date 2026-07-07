import pg from "pg";
import { applyMigrations, rollbackLast, appliedVersions } from "./migrations/index.ts";

// CLI migration runner (CORE-06): `node src/migrate.ts up|down|status`.
async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "up";
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set");
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    if (cmd === "up") {
      const applied = await applyMigrations(pool);
      console.log(`Applied migrations: ${applied.join(", ") || "(none)"}`);
    } else if (cmd === "down") {
      const rolled = await rollbackLast(pool);
      console.log(
        rolled === null
          ? "Nothing to roll back"
          : `Rolled back migration ${rolled}`,
      );
    } else if (cmd === "status") {
      const versions = await appliedVersions(pool);
      console.log(`Applied versions: ${versions.join(", ") || "(none)"}`);
    } else {
      throw new Error(`Unknown command: ${cmd} (use up|down|status)`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
