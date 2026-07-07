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

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });

export type Database = typeof db;
