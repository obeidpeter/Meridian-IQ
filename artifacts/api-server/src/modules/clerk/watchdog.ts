import { sql } from "drizzle-orm";
import { getDb } from "@workspace/db";
import { logger } from "../../lib/logger";
import { appendAudit } from "../audit/audit";
import { isFeatureEnabled, setFlag } from "../flags/flags";
import { registerSweep } from "../pipeline/pipeline";
import { CLERK_FLAG_KEY } from "./gateway";

// Clerk watchdog (CLK-OBS-03 / the severity-zero reflex): when the model
// starts producing schema-invalid output or erroring at a high rate, disable
// the whole capability automatically instead of waiting for a human to notice
// the Health tab. Pure rules over the append-only inference ledger — the same
// deterministic-controls posture as everything else in this module.
//
// Thresholds are deliberately conservative and env-tunable: a trip needs a
// real sample (not two flaky calls) AND a majority-bad rate inside a short
// window. Re-enabling after a trip is a deliberate human act on the feature
// flag; the watchdog never turns Clerk back on.

const WINDOW_MINUTES = Number(process.env.CLERK_WATCHDOG_WINDOW_MINUTES ?? 60);
const MIN_SAMPLE = Number(process.env.CLERK_WATCHDOG_MIN_SAMPLE ?? 10);
const TRIP_RATE = Number(process.env.CLERK_WATCHDOG_TRIP_RATE ?? 0.5);

export interface WatchdogResult {
  checked: boolean; // false when Clerk is already off (nothing to guard)
  tripped: boolean;
  sample: number;
  badRate: number;
}

// Flag access is injectable so tests can exercise the trip logic without
// mutating the real platform flag (test files run concurrently against one
// database; a test flipping the shared flag races every other Clerk test).
export interface WatchdogDeps {
  isEnabled: () => Promise<boolean>;
  disable: () => Promise<void>;
}

const realDeps: WatchdogDeps = {
  isEnabled: () => isFeatureEnabled(CLERK_FLAG_KEY),
  disable: () => setFlag(CLERK_FLAG_KEY, false),
};

export async function runClerkWatchdog(
  deps: WatchdogDeps = realDeps,
): Promise<WatchdogResult> {
  // Already off (manually or by a previous trip): nothing to guard, and the
  // watchdog must never mask a deliberate operator disable by re-evaluating.
  if (!(await deps.isEnabled())) {
    return { checked: false, tripped: false, sample: 0, badRate: 0 };
  }

  const rows = (
    await getDb().execute(sql`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE outcome IN ('invalid_discarded', 'error'))::int
          AS bad
      FROM clerk_inference_calls
      WHERE created_at >= now() - make_interval(mins => ${WINDOW_MINUTES})
    `)
  ).rows as { total: number; bad: number }[];

  const total = rows[0]?.total ?? 0;
  const bad = rows[0]?.bad ?? 0;
  const badRate = total === 0 ? 0 : bad / total;

  if (total < MIN_SAMPLE || badRate < TRIP_RATE) {
    return { checked: true, tripped: false, sample: total, badRate };
  }

  await deps.disable();
  await appendAudit({
    actorId: "clerk-watchdog",
    actorRole: "system",
    action: "clerk.kill_switch.auto_tripped",
    entityType: "feature_flag",
    entityId: CLERK_FLAG_KEY,
    after: {
      badRate: Number(badRate.toFixed(4)),
      sample: total,
      windowMinutes: WINDOW_MINUTES,
      reason:
        "Invalid/error inference rate crossed the watchdog threshold; Clerk disabled pending human review.",
    },
  });
  logger.error(
    {
      badRate,
      sample: total,
      windowMinutes: WINDOW_MINUTES,
    },
    "Clerk watchdog TRIPPED: clerk_ai disabled automatically. Re-enable via the feature flag after investigating the inference ledger.",
  );
  return { checked: true, tripped: true, sample: total, badRate };
}

registerSweep(runClerkWatchdog);
