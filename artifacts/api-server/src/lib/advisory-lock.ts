import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@workspace/db";

// The transaction-scoped advisory try-lock probe, one home. Every sweep's
// gating/candidate transaction opens with exactly this probe (a concurrent
// pass skips instead of piling up), and the feed engine uses it for
// per-connection mutual exclusion — hence the neutral name. Each caller
// keeps its own lock-id constant and its own reaction to `!locked`.
//
// ONLY valid inside a tx-bound context (runInBypassContext /
// runRequestContext): pg_try_advisory_xact_lock holds until the enclosing
// transaction ends, and with no ALS context getDb() is the bare pool —
// autocommit, so the lock dies at statement end and the probe guards
// nothing.
//
// The xact try-lock id catalogue (this helper's callers): 731_842 eval
// growth, 731_843 digest, 731_844 client statements, 731_845 red team,
// 731_846 phrasing watch, 731_847 filing mint, 731_848 onboarding refresh,
// 731_850 memory indexer, 731_851 retrieval eval, 731_852 advisory brief;
// 731_849 is unused. The feed engine keys hashtext(connection id) instead
// of a constant. Out of scope: the BLOCKING pg_advisory_xact_lock sites
// (audit's 918273 serializer, per-invoice/per-user hashtext locks) and the
// session-scope locks (clerk budget, pipeline poller,
// provider-operation-lock.ts), which have a different lifetime.
export async function tryAdvisoryXactLock(key: number | SQL): Promise<boolean> {
  const [{ locked }] = (
    await getDb().execute<{ locked: boolean }>(
      sql`SELECT pg_try_advisory_xact_lock(${key}) AS locked`,
    )
  ).rows;
  return locked;
}
