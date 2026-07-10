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

// A dropped/unroutable connection must fail fast and loud rather than hang the
// caller forever: pg has no default connect timeout, so without this a boot-time
// DB reach problem would silently block startup. keepAlive avoids idle NAT/proxy
// drops on long-lived pooled connections in the deployed environment.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 10_000,
  keepAlive: true,
});
export const db = drizzle(pool, { schema });

export type Database = typeof db;
