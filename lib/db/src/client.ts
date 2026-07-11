import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index.ts";

const { Pool } = pg;

// Boot-time guard, called by server/migration entrypoints so a missing
// DATABASE_URL still fails fast where it matters. Importing this module must
// NOT require a database: pure-function test suites (node --test) import
// modules that transitively reach this file without ever touching the pool,
// and pg only dials the connection on first use.
export function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL must be set. Did you forget to provision a database?",
    );
  }
  return url;
}

// Explicit pool sizing (CON-M4). The worker (drain + reconcile + compliance
// sweeps, each now reentrancy-guarded so at most one of each runs at a time) and
// all HTTP request transactions share this pool; the pg default of 10 is easily
// starved under pipeline load, stalling requests until the 30s request-tx
// timeout. Size it explicitly with headroom and make it env-tunable, and fail a
// request that cannot get a connection rather than hanging indefinitely.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PGPOOL_MAX ?? 20),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000,
});
export const db = drizzle(pool, { schema });

export type Database = typeof db;
