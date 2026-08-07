// Onboarding refresh sweep: keeps every ACTIVE run's checklist current
// without anyone clicking refresh — uploads land, consent is granted, a
// month closes, and the checklist follows within the hour. Cheap when
// nothing is onboarding (one indexed scan finds no candidates), and safe to
// race: detection is idempotent recomputation and both terminal transitions
// are status-guarded CAS updates inside refreshOnboardingRun, so the
// advisory lock only dedupes ONE instance's pass — correctness never rests
// on it (the filing mint sweep's shape).
import { sql } from "drizzle-orm";
import { getDb, runInBypassContext } from "@workspace/db";
import { logger } from "../../lib/logger";
import { refreshOnboardingRun } from "./onboarding";

// Fresh advisory lock id (731_842..846 clerk watches, 731_847 filing mint).
const ONBOARDING_SWEEP_LOCK_ID = 731_848;

export async function sweepOnboardingRuns(): Promise<{
  refreshed: number;
}> {
  const candidates = await runInBypassContext(async () => {
    const [{ locked }] = (
      await getDb().execute<{ locked: boolean }>(
        sql`SELECT pg_try_advisory_xact_lock(${ONBOARDING_SWEEP_LOCK_ID}) AS locked`,
      )
    ).rows;
    if (!locked) return [];
    return (
      await getDb().execute<{ id: string; firm_id: string }>(sql`
        SELECT id, firm_id
        FROM client_onboarding_runs
        WHERE status = 'active'
        ORDER BY updated_at ASC
      `)
    ).rows;
  });
  let refreshed = 0;
  for (const run of candidates) {
    // Per-run bypass scope so one broken run cannot wedge the pass; the
    // refresh's own CAS discipline makes a mid-loop crash harmless.
    try {
      await runInBypassContext(() =>
        refreshOnboardingRun(run.id, run.firm_id),
      );
      refreshed += 1;
    } catch (err) {
      logger.warn(
        { runId: run.id, err: err instanceof Error ? err.message : String(err) },
        "onboarding refresh sweep: run failed",
      );
    }
  }
  return { refreshed };
}
