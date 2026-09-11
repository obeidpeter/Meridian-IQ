import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index.ts";
import {
  connectionConfig,
  workerConnectionConfig,
} from "./connection-config.ts";
export type { PoolClient } from "pg";

const { Pool } = pg;

type ConnectCallback = (
  error: Error | undefined,
  client: pg.PoolClient | undefined,
  release: (error?: Error | boolean) => void,
) => void;
class MeasuredPool extends Pool {
  private pending = new Map<symbol, number>();
  acquisitionCount = 0;
  acquisitionFailures = 0;
  acquisitionSeconds = 0;

  get oldestAcquisitionSeconds(): number {
    const now = performance.now();
    let oldest = now;
    for (const started of this.pending.values())
      oldest = Math.min(oldest, started);
    return (now - oldest) / 1_000;
  }

  override connect(): Promise<pg.PoolClient>;
  override connect(callback: ConnectCallback): void;
  override connect(callback?: ConnectCallback): Promise<pg.PoolClient> | void {
    const key = Symbol();
    const started = performance.now();
    this.pending.set(key, started);
    const finish = () => {
      this.pending.delete(key);
      this.acquisitionCount += 1;
      this.acquisitionSeconds += (performance.now() - started) / 1_000;
    };
    const acquire = (done: ConnectCallback) => {
      try {
        super.connect((error, client, release) => {
          finish();
          if (error) this.acquisitionFailures += 1;
          done(error, client, release);
        });
      } catch (error) {
        finish();
        this.acquisitionFailures += 1;
        throw error;
      }
    };
    if (callback) return acquire(callback);
    return new Promise((resolve, reject) =>
      acquire((error, client) => {
        if (error) reject(error);
        else if (client) resolve(client);
        else reject(new Error("PostgreSQL acquisition returned no client"));
      }),
    );
  }
}

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
export const pool = new MeasuredPool(connectionConfig());
export const workerLockPool = new MeasuredPool(workerConnectionConfig());

const idleErrors = { application: 0, worker: 0 };
const connectionState = {
  application: {
    consecutiveErrors: 0,
    lastErrorAt: null as number | null,
    lastConnectedAt: null as number | null,
  },
  worker: {
    consecutiveErrors: 0,
    lastErrorAt: null as number | null,
    lastConnectedAt: null as number | null,
  },
};
for (const [name, target] of [
  ["application", pool],
  ["worker", workerLockPool],
] as const) {
  target.on("connect", () => {
    connectionState[name].consecutiveErrors = 0;
    connectionState[name].lastConnectedAt = Date.now() / 1_000;
  });
  target.on("error", (error: Error & { code?: string }) => {
    idleErrors[name] += 1;
    connectionState[name].consecutiveErrors += 1;
    connectionState[name].lastErrorAt = Date.now() / 1_000;
    // Never log connection strings, SQL, or server-provided detail fields.
    console.error(
      JSON.stringify({
        event: "postgres_idle_client_error",
        pool: name,
        code: /^[A-Z0-9]{5}$/.test(error.code ?? "") ? error.code : "unknown",
      }),
    );
  });
}

export function databasePoolMetrics() {
  return (
    [
      ["application", pool],
      ["worker", workerLockPool],
    ] as const
  ).map(([name, target]) => ({
    name,
    total: target.totalCount,
    idle: target.idleCount,
    active: target.totalCount - target.idleCount,
    waiting: target.waitingCount,
    max: target.options.max ?? 0,
    idleErrors: idleErrors[name],
    consecutiveConnectionErrors: connectionState[name].consecutiveErrors,
    lastConnectionErrorAt: connectionState[name].lastErrorAt,
    lastConnectedAt: connectionState[name].lastConnectedAt,
    oldestAcquisitionSeconds: target.oldestAcquisitionSeconds,
    acquisitionCount: target.acquisitionCount,
    acquisitionFailures: target.acquisitionFailures,
    acquisitionSeconds: target.acquisitionSeconds,
  }));
}

export async function closeDatabasePools(): Promise<void> {
  await Promise.all([pool.end(), workerLockPool.end()]);
}
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
    `SELECT pg_has_role(current_user, 'meridian_app', 'SET') AS can_set`,
  );
  return after[0]?.can_set === true ? "granted" : "still-denied";
}
