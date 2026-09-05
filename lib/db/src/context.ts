import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import { db, pool, type Database } from "./client.ts";
import {
  ScopedTransaction,
  assertDatabaseLifetime,
  transactionLifetime,
  type DatabaseLifetime,
} from "./scoped-transaction.ts";

// Request/worker DB context (CON-01, SEC-02/03).
//
// Row-level tenant isolation is enforced in Postgres via RLS policies keyed to
// two transaction-local GUCs:
//   - app.firm_id  : the tenant a firm-scoped principal may see
//   - app.bypass   : 'on' for cross-tenant staff (operator/auditor/bank) and
//                    trusted internal work (seed, async worker)
//
// Every request runs inside one transaction that (a) SET LOCAL ROLE to the
// non-privileged meridian_app role — the pool's login role is a BYPASSRLS
// superuser, so without this the policies would never fire — and (b) sets these
// GUCs. All query call sites read the ambient transaction via getDb() so the
// policies apply at the data layer, not merely in handler guards.
//
// HTTP getDb() fails closed without a live context, including exempt routes
// and async descendants. Only credential/membership resolution can explicitly
// use getSystemDb before authentication ends. Non-HTTP boot/test/worker callers
// retain a documented transitional raw fallback; they are not tenant-isolated.

interface DbContext extends DatabaseLifetime {
  db: Database;
}

const storage = new AsyncLocalStorage<DbContext>();
const correlationStorage = new AsyncLocalStorage<string | null>();
const httpStorage = new AsyncLocalStorage<{ authenticating: boolean }>();

/** HTTP must opt into tenant/system transactions; async descendants retain this marker. */
export function runHttpDatabaseBoundary<T>(fn: () => T): T {
  return storage.exit(() => httpStorage.run({ authenticating: true }, fn));
}

/** Close raw pre-auth access before rate limiting and route dispatch. */
export function finishHttpAuthentication(): void {
  const request = httpStorage.getStore();
  if (request) request.authenticating = false;
}

export function hasDatabaseContext(): boolean {
  const context = storage.getStore();
  assertContextActive(context);
  return !!context;
}

const assertContextActive = assertDatabaseLifetime;

/** Credential/membership resolution only. Never a route-handler bypass. */
export function getSystemDb(purpose: "authentication"): Database {
  if (purpose !== "authentication")
    throw new Error("Unknown system database purpose");
  const context = storage.getStore();
  if (context) return getDb();
  const request = httpStorage.getStore();
  if (request && !request.authenticating) {
    throw new Error(
      "System authentication database access is forbidden in HTTP handlers",
    );
  }
  return db;
}

// Bind an inbound request reference independently of the database transaction.
// Routes that deliberately own short transactions can then preserve the same
// support reference without keeping a pooled connection open around network IO.
export function runCorrelationContext<T>(
  correlationId: string | null,
  fn: () => T,
): T {
  return correlationStorage.run(correlationId, fn);
}

export function currentCorrelationId(): string | null {
  return correlationStorage.getStore() ?? null;
}

// HTTP is fail-closed. The non-HTTP fallback is transitional for boot, workers
// and test fixtures, not an implicit privilege granted to route handlers.
export function getDb(): Database {
  const context = storage.getStore();
  if (!context) {
    if (httpStorage.getStore())
      throw new Error(
        "HTTP database access requires an explicit database context",
      );
    return db;
  }
  assertContextActive(context);
  return context.db;
}

// Bind a nested transaction/savepoint as the ambient handle. Merely calling
// getDb().transaction() is insufficient when downstream services call getDb().
// The child shares the execution guard's lifetime, protecting cached handles too.
export async function withTransaction<T>(fn: () => Promise<T>): Promise<T> {
  const parent = storage.getStore();
  if (!parent) {
    getDb(); // Missing HTTP context must fail before opening a system transaction.
    return runInBypassContext(fn);
  }
  return getDb().transaction(async (tx) => {
    assertContextActive(parent);
    const context = Object.assign(transactionLifetime(tx), {
      db: tx as unknown as Database,
    });
    try {
      return await storage.run(context, fn);
    } finally {
      context.active = false;
    }
  });
}

async function setGucs(
  tx: Database,
  opts: {
    bypass: boolean;
    firmId: string | null;
    correlationId?: string | null;
  },
): Promise<void> {
  // Drop superuser privileges for the rest of the transaction so RLS applies.
  await tx.execute(sql`SET LOCAL ROLE meridian_app`);
  await tx.execute(
    sql`SELECT set_config('app.bypass', ${opts.bypass ? "on" : "off"}, true)`,
  );
  if (!opts.bypass && opts.firmId) {
    await tx.execute(
      sql`SELECT set_config('app.firm_id', ${opts.firmId}, true)`,
    );
  }
  if (opts.correlationId) {
    await tx.execute(
      sql`SELECT set_config('app.correlation_id', ${opts.correlationId}, true)`,
    );
  }
}

// Core entry: open a transaction, bind the RLS GUCs, and run `fn` with the
// scoped transaction as the ambient getDb(). The request middleware calls this
// directly with the principal-derived options.
export async function runRequestContext<T>(
  opts: {
    bypass: boolean;
    firmId: string | null;
    correlationId?: string | null;
  },
  fn: () => Promise<T>,
): Promise<T> {
  hasDatabaseContext(); // Reject a stale async continuation before it can reopen a context.
  const parent = storage.getStore();
  const client = await pool.connect();
  const lifetime: DatabaseLifetime = { active: true, parent };
  const scoped = new ScopedTransaction(client, lifetime) as unknown as Database;
  const context = Object.assign(lifetime, { db: scoped });
  let began = false;
  let reusable = false;
  let connectionFailed = false;
  const onError = () => {
    connectionFailed = true;
    context.active = false;
  };
  client.on("error", onError);
  try {
    assertContextActive(parent);
    await client.query("BEGIN");
    began = true;
    const correlationId =
      opts.correlationId === undefined
        ? currentCorrelationId()
        : opts.correlationId;
    await setGucs(scoped, { ...opts, correlationId });
    assertContextActive(context);
    const result = await storage.run(context, fn);
    assertContextActive(context);
    context.active = false;
    // Revoke application dispatch BEFORE cleanup. node-postgres queues commands
    // on one client, so already-issued work drains before this terminal command.
    await client.query("COMMIT");
    reusable = true;
    return result;
  } catch (error) {
    context.active = false;
    if (began && !connectionFailed) {
      try {
        await client.query("ROLLBACK");
        reusable = true;
      } catch {
        // An uncertain transaction is never returned to the shared pool.
      }
    }
    throw error;
  } finally {
    context.active = false;
    client.removeListener("error", onError);
    client.release(!reusable || connectionFailed);
  }
}

// Run `fn` inside a transaction that bypasses tenant RLS (cross-tenant staff and
// trusted internal work: seeding, the async submission worker, reconciliation).
export async function runInBypassContext<T>(
  fn: () => Promise<T>,
  opts: { correlationId?: string | null } = {},
): Promise<T> {
  return runRequestContext(
    { bypass: true, firmId: null, correlationId: opts.correlationId },
    fn,
  );
}

/** A database-only stage: retain caller atomicity/RLS or open the explicit scope. */
export async function withDatabaseContext<T>(
  opts: Parameters<typeof runRequestContext>[0],
  fn: () => Promise<T>,
): Promise<T> {
  return hasDatabaseContext() ? fn() : runRequestContext(opts, fn);
}
