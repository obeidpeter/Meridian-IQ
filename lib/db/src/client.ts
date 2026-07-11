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
//
// A dropped/unroutable connection must also fail fast and loud rather than hang
// the caller forever: pg has no default connect timeout, so without this a
// boot-time DB reach problem would silently block startup. keepAlive avoids idle
// NAT/proxy drops on long-lived pooled connections in the deployed environment.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PGPOOL_MAX ?? 20),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  keepAlive: true,
});
export const db = drizzle(pool, { schema });

export type Database = typeof db;

export type AppRoleStatus =
  | "already-assumable"
  | "granted"
  | "role-missing"
  | "still-denied";

// Ensure the pool's login role can `SET ROLE meridian_app` — the non-privileged,
// non-BYPASSRLS role every request/worker transaction assumes so RLS actually
// applies (see context.ts).
//
// In development the login is a superuser (`postgres`) and may assume any role,
// so this is a no-op ("already-assumable"). In a Replit deployment the login is a
// NON-superuser (`neondb_owner`) which Neon makes a *member* of meridian_app but
// WITHOUT the PostgreSQL 16 "SET" membership option — so `SET ROLE meridian_app`
// is denied ("permission denied to set role") and every request 500s. Role
// memberships are cluster-level and are carried by neither Publish's schema diff
// nor the dev->prod data copy, so the application repairs its own SET privilege
// here. It only writes when the privilege is missing, and the write itself needs
// ADMIN on the role (which neondb_owner holds); otherwise it reports the failure
// to the caller instead of throwing.
export async function ensureAppRoleAssumable(): Promise<AppRoleStatus> {
  const { rows } = await pool.query<{
    role_exists: boolean;
    can_set: boolean;
  }>(
    `SELECT
       EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meridian_app') AS role_exists,
       pg_has_role(current_user, 'meridian_app', 'SET') AS can_set`,
  );
  if (rows[0]?.role_exists !== true) return "role-missing";
  if (rows[0]?.can_set === true) return "already-assumable";

  await pool.query(`GRANT meridian_app TO CURRENT_USER WITH SET TRUE`);

  const { rows: after } = await pool.query<{ can_set: boolean }>(
    `SELECT pg_has_role(current_user, 'meridian_app', 'USAGE') AS can_set`,
  );
  return after[0]?.can_set === true ? "granted" : "still-denied";
}
