import { desc, isNull, sql } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  clerkPhrasingEvalRunsTable,
  type ClerkPhrasingEvalRun,
} from "@workspace/db";
import { registerSweep } from "../pipeline/pipeline";
import { logger } from "../../lib/logger";
import { isFeatureEnabled } from "../flags/flags";
import { CLERK_FLAG_KEY } from "./gateway";
import { getClerkGateway } from "./provider";
import { runPhrasingEval } from "./phrasing-eval";
import {
  alertOnceViaAuditLedger,
  atMostHourly,
  envThreshold,
} from "./watch-shared";

// Nightly phrasing eval + quality-drop alert (round-20 idea #1). The
// phrasing lane (rounds 18-20) only guarded production when an operator
// remembered to click "run" — this closes the loop with the two existing
// disciplines composed:
//  - the eval-growth NIGHTLY pattern: an opt-in flag (each run spends
//    platform tokens), at most once per UTC day, advisory-locked in a
//    SHORT bypass transaction with the model calls OUTSIDE it;
//  - the resistance-watch ALERT pattern: pure rules over the stored runs,
//    a durable once-only audit event plus an error-level log line, and no
//    automatic action — a quality dip needs a human, not a kill switch.
// Rates (not absolute counts) are compared so the alert survives corpus
// growth: adding fixtures in a new round must not read as a regression.

const AUTO_PHRASING_FLAG_KEY = "clerk_auto_phrasing_eval";
const PHRASING_SWEEP_LOCK_ID = 731_846;

// Baseline needs a real history: fewer prior runs than this and the sweep
// stays quiet (a second-ever run has nothing meaningful to drop from).
const MAX_BASELINE_RUNS = 5;
// Clamped to the baseline window: a MIN above MAX_BASELINE_RUNS could
// never be satisfied by the fetched rows and would silence the watch
// forever (review-confirmed L2).
const MIN_BASELINE_RUNS = Math.min(
  envThreshold(process.env.PHRASING_ALERT_MIN_RUNS, 3),
  MAX_BASELINE_RUNS,
);
const DROP_POINTS = envThreshold(process.env.PHRASING_ALERT_DROP, 0.1);

export const PHRASING_DROP_ACTION = "clerk.phrasing_quality.dropped";

export interface PhrasingQualityDrop {
  metric: "grounded" | "resistance";
  baselineRate: number;
  newestRate: number;
  baselineRuns: number;
  newestRunId: string;
}

// Pure detection, exported for tests. `runs` newest-first (the list
// endpoint's order). The newest run is compared against the AGGREGATE of
// the up-to-MAX_BASELINE_RUNS runs before it (summed counts over summed
// totals — one flaky old run cannot dominate the baseline). When both
// rates dropped, resistance wins the report — it is the safety metric.
export function detectPhrasingQualityDrop(
  runs: Pick<
    ClerkPhrasingEvalRun,
    | "id"
    | "fixtureCount"
    | "groundedCount"
    | "injectionFixtures"
    | "injectionResisted"
  >[],
): PhrasingQualityDrop | null {
  if (runs.length < MIN_BASELINE_RUNS + 1) return null;
  const newest = runs[0];
  const baseline = runs.slice(1, 1 + MAX_BASELINE_RUNS);

  const sum = (f: (r: (typeof runs)[number]) => number) =>
    baseline.reduce((acc, r) => acc + f(r), 0);
  const drops: PhrasingQualityDrop[] = [];

  const baseInjection = sum((r) => r.injectionFixtures);
  if (baseInjection > 0 && newest.injectionFixtures > 0) {
    const baseRate = sum((r) => r.injectionResisted) / baseInjection;
    const newRate = newest.injectionResisted / newest.injectionFixtures;
    if (baseRate - newRate >= DROP_POINTS) {
      drops.push({
        metric: "resistance",
        baselineRate: Number(baseRate.toFixed(4)),
        newestRate: Number(newRate.toFixed(4)),
        baselineRuns: baseline.length,
        newestRunId: newest.id,
      });
    }
  }
  const baseFixtures = sum((r) => r.fixtureCount);
  if (baseFixtures > 0 && newest.fixtureCount > 0) {
    const baseRate = sum((r) => r.groundedCount) / baseFixtures;
    const newRate = newest.groundedCount / newest.fixtureCount;
    if (baseRate - newRate >= DROP_POINTS) {
      drops.push({
        metric: "grounded",
        baselineRate: Number(baseRate.toFixed(4)),
        newestRate: Number(newRate.toFixed(4)),
        baselineRuns: baseline.length,
        newestRunId: newest.id,
      });
    }
  }
  return drops.find((d) => d.metric === "resistance") ?? drops[0] ?? null;
}

// True when no auto run (startedBy null) has happened today (UTC) — the
// eval-growth once-per-day guard verbatim.
async function autoPhrasingDueToday(): Promise<boolean> {
  const [last] = await getDb()
    .select({ createdAt: clerkPhrasingEvalRunsTable.createdAt })
    .from(clerkPhrasingEvalRunsTable)
    .where(isNull(clerkPhrasingEvalRunsTable.startedBy))
    .orderBy(desc(clerkPhrasingEvalRunsTable.createdAt))
    .limit(1);
  if (!last) return true;
  const today = new Date().toISOString().slice(0, 10);
  return last.createdAt.toISOString().slice(0, 10) !== today;
}

registerSweep(async function sweepPhrasingAutoEval(): Promise<void> {
  const runEval = await runInBypassContext(async () => {
    const [{ locked }] = (
      await getDb().execute<{ locked: boolean }>(
        sql`SELECT pg_try_advisory_xact_lock(${PHRASING_SWEEP_LOCK_ID}) AS locked`,
      )
    ).rows;
    if (!locked) return false;
    // Each run spends platform tokens: opt-in flag, at most once per UTC
    // day. Race losers record a second startedBy-null row, which the
    // due-today check then ignores for the rest of the day. The kill
    // switch is checked HERE too (review-confirmed M2): with clerk_ai off
    // no run row lands, so an unguarded runPhrasingEval would throw
    // CLERK_DISABLED on every 60-second pass all day and redden the
    // shared sweep health for the duration of an incident.
    if (!(await isFeatureEnabled(CLERK_FLAG_KEY))) return false;
    if (!(await isFeatureEnabled(AUTO_PHRASING_FLAG_KEY))) return false;
    return autoPhrasingDueToday();
  });
  if (!runEval) return;

  // Belt and braces for the TOCTOU (the flag can flip between the check
  // and the call) and for a missing provider: either answers with a quiet
  // log, never a failed sweep pass.
  try {
    const gateway = await getClerkGateway();
    const run = await runPhrasingEval(null, gateway);
    logger.info(
      {
        fixtureCount: run.fixtureCount,
        correctCount: run.correctCount,
        groundedCount: run.groundedCount,
        injectionResisted: run.injectionResisted,
      },
      "phrasing lane: nightly eval run complete",
    );
  } catch (err) {
    logger.warn(
      { err },
      "phrasing lane: nightly eval skipped (clerk disabled or provider unavailable)",
    );
  }
});

export interface PhrasingWatchResult {
  checked: boolean;
  dropped: boolean;
  alerted: boolean;
}

// Injectable run source (the resistance-watch deps trick) so tests can
// exercise detection/dedup without depending on stored runs. Only the
// detection fields are required — the full row also satisfies it.
export type PhrasingWatchRun = Pick<
  ClerkPhrasingEvalRun,
  | "id"
  | "fixtureCount"
  | "groundedCount"
  | "injectionFixtures"
  | "injectionResisted"
>;

export interface PhrasingWatchDeps {
  runs: () => Promise<PhrasingWatchRun[]>;
}

const realDeps: PhrasingWatchDeps = {
  runs: () =>
    getDb()
      .select()
      .from(clerkPhrasingEvalRunsTable)
      .orderBy(
        desc(clerkPhrasingEvalRunsTable.createdAt),
        desc(clerkPhrasingEvalRunsTable.id),
      )
      .limit(1 + MAX_BASELINE_RUNS),
};

// One alert per degraded run: entity_id = the run that dropped.
const alertPhrasingDrop = alertOnceViaAuditLedger({
  action: PHRASING_DROP_ACTION,
  entityType: "clerk_phrasing_eval_run",
  actorId: "phrasing-watch",
});

export async function sweepPhrasingWatch(
  deps: PhrasingWatchDeps = realDeps,
): Promise<PhrasingWatchResult> {
  return runInBypassContext(async () => {
    const drop = detectPhrasingQualityDrop(await deps.runs());
    if (!drop) return { checked: true, dropped: false, alerted: false };

    const alerted = await alertPhrasingDrop(
      drop.newestRunId,
      {
        metric: drop.metric,
        baselineRate: drop.baselineRate,
        newestRate: drop.newestRate,
        baselineRuns: drop.baselineRuns,
        reason:
          "The newest phrasing eval run fell materially below the trailing baseline; review the run's named failures and recent prompt changes on the Clerk health page.",
      },
      `Phrasing ${drop.metric === "resistance" ? "injection resistance" : "number grounding"} DROPPED vs the trailing baseline: review Clerk health before promoting any prompt change.`,
    );
    return { checked: true, dropped: true, alerted };
  });
}

registerSweep(atMostHourly(sweepPhrasingWatch));
