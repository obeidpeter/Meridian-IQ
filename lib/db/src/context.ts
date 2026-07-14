import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import { db, type Database } from "./client.ts";

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
// Outside any context, getDb() falls back to the raw pool, which runs as the
// superuser owner and is NOT tenant-isolated. That fallback is used only for
// pre-context, non-tenant lookups (e.g. resolving a principal from users /
// memberships, neither of which carries RLS); every tenant-scoped table is only
// ever touched from inside one of the contexts below.

interface DbContext {
  db: Database;
}

const storage = new AsyncLocalStorage<DbContext>();

// The ambient tenant-scoped transaction, or the raw pool when none is active.
export function getDb(): Database {
  return storage.getStore()?.db ?? db;
}

async function setGucs(
  tx: Database,
  opts: { bypass: boolean; firmId: string | null },
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
}

// Core entry: open a transaction, bind the RLS GUCs, and run `fn` with the
// scoped transaction as the ambient getDb(). The request middleware calls this
// directly with the principal-derived options.
export async function runRequestContext<T>(
  opts: { bypass: boolean; firmId: string | null },
  fn: () => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Database;
    await setGucs(scoped, opts);
    return storage.run({ db: scoped }, fn);
  });
}

// Run `fn` inside a transaction that bypasses tenant RLS (cross-tenant staff and
// trusted internal work: seeding, the async submission worker, reconciliation).
export async function runInBypassContext<T>(fn: () => Promise<T>): Promise<T> {
  return runRequestContext({ bypass: true, firmId: null }, fn);
}
