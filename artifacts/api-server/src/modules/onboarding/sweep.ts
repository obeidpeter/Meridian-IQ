// Onboarding refresh sweep: keeps every ACTIVE run's checklist current
// without anyone clicking refresh — uploads land, consent is granted, a
// month closes, and the checklist follows within the hour. Cheap when
// nothing is onboarding (the active-run scan rides the partial live-run
// index over a small table), and safe to race: detection is idempotent
// recomputation and both terminal transitions are status-guarded CAS
// updates inside refreshOnboardingRun, so the advisory lock only dedupes
// ONE instance's pass — correctness never rests on it (the filing mint
// sweep's shape).
import { and, eq, sql } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  clientOnboardingRunsTable,
} from "@workspace/db";
import { logger } from "../../lib/logger";
import { appendAudit } from "../audit/audit";
import { DomainError } from "../errors";
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
      if (err instanceof DomainError && err.code === "NOT_FOUND") {
        // The record under the run vanished (the client party row is gone):
        // detection can never succeed again, so the run must not warn-loop
        // hourly forever — abandon it through the same status-guarded CAS
        // as every other terminal transition.
        await runInBypassContext(async () => {
          const [abandoned] = await getDb()
            .update(clientOnboardingRunsTable)
            .set({ status: "abandoned", updatedAt: new Date() })
            .where(
              and(
                eq(clientOnboardingRunsTable.id, run.id),
                eq(clientOnboardingRunsTable.status, "active"),
              ),
            )
            .returning();
          if (abandoned) {
            await appendAudit({
              firmId: run.firm_id,
              action: "onboarding.run_abandoned",
              entityType: "onboarding_run",
              entityId: run.id,
              after: { reason: "record_missing" },
            });
          }
        });
        continue;
      }
      logger.warn(
        { runId: run.id, err: err instanceof Error ? err.message : String(err) },
        "onboarding refresh sweep: run failed",
      );
    }
  }
  return { refreshed };
}
