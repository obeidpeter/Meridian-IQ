// Pre-push extension bootstrap: `drizzle-kit push` creates tables from the
// schema, and the memory rail's embedding column needs the pgvector type to
// exist FIRST — so the push script runs this before drizzle-kit (the
// migrate path re-asserts the same extension in 0038 for boots that never
// push). TOLERANT by design: on a cluster whose postgres lacks the pgvector
// binary this logs and exits 0 — the push itself will then fail loudly on
// the vector column, naming the real prerequisite, instead of this step
// masking it.
import pg from "pg";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("ensure-extensions: DATABASE_URL is required");
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
    console.log("ensure-extensions: pgvector present");
  } catch (err) {
    console.warn(
      `ensure-extensions: could not create the pgvector extension (${err instanceof Error ? err.message : String(err)}) — ` +
        "the memory rail's schema will not converge until the cluster provides it",
    );
  } finally {
    await pool.end();
  }
}

void main();
