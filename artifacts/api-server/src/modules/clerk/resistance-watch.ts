import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, runInBypassContext, auditEventsTable } from "@workspace/db";
import { logger } from "../../lib/logger";
import { appendAudit } from "../audit/audit";
import { registerSweep } from "../pipeline/pipeline";

// Resistance-drop alert (round-8 idea #2). The injection-resistance trend
// (metrics.injectionTrend) is a chart someone has to look at; the red team
// keeps generating harder attacks, so a silent month-over-month decline is
// exactly the failure mode nobody notices until it matters. This sweep runs
// the SAME monthly buckets as the trend chart and raises a durable alert —
// an audit event plus an error-level log line — the first time a month's
// resistance falls materially below the previous measured month. Pure rules
// over stored eval runs: zero model calls, and unlike the watchdog it takes
// no automatic action (a resistance dip needs a human judgement, not a kill
// switch).
//
// Thresholds are env-tunable and deliberately need a real sample: a month
// with a handful of injection fixtures produces rates too noisy to alert on.

const MIN_FIXTURES = Number(process.env.RESISTANCE_ALERT_MIN_FIXTURES ?? 5);
const DROP_POINTS = Number(process.env.RESISTANCE_ALERT_DROP ?? 0.1);

export const RESISTANCE_DROP_ACTION = "clerk.injection_resistance.dropped";

export interface ResistanceMonth {
  month: string; // "YYYY-MM" (UTC)
  runs: number;
  injectionFixtures: number;
  injectionResisted: number;
}

export interface ResistanceDrop {
  fromMonth: string;
  toMonth: string;
  fromRate: number;
  toRate: number;
  injectionFixtures: number; // the degraded month's sample size
}

// The trend chart's month buckets — one query, shared with getClerkMetrics so
// the alert and the chart can never disagree about the numbers.
export async function injectionResistanceMonths(): Promise<ResistanceMonth[]> {
  const rows = (
    await getDb().execute<{
      month: string;
      runs: number;
      injection_fixtures: number;
      injection_resisted: number;
    }>(sql`
      SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
        COUNT(*)::int AS runs,
        SUM(injection_fixtures)::int AS injection_fixtures,
        SUM(injection_resisted)::int AS injection_resisted
      FROM clerk_eval_runs
      WHERE created_at >= date_trunc('month', now()) - interval '5 months'
      GROUP BY 1
      ORDER BY 1
    `)
  ).rows;
  return rows.map((r) => ({
    month: r.month,
    runs: Number(r.runs),
    injectionFixtures: Number(r.injection_fixtures),
    injectionResisted: Number(r.injection_resisted),
  }));
}

// Pure detection, exported for tests: compare the two NEWEST months that each
// carry a real sample (>= MIN_FIXTURES injection fixtures — thin months are
// skipped, not compared). A drop of DROP_POINTS or more between them alerts.
export function detectResistanceDrop(
  months: ResistanceMonth[],
): ResistanceDrop | null {
  const measured = [...months]
    .sort((a, b) => a.month.localeCompare(b.month))
    .filter((m) => m.injectionFixtures >= MIN_FIXTURES);
  if (measured.length < 2) return null;
  const from = measured[measured.length - 2];
  const to = measured[measured.length - 1];
  const fromRate = from.injectionResisted / from.injectionFixtures;
  const toRate = to.injectionResisted / to.injectionFixtures;
  if (fromRate - toRate < DROP_POINTS) return null;
  return {
    fromMonth: from.month,
    toMonth: to.month,
    fromRate: Number(fromRate.toFixed(4)),
    toRate: Number(toRate.toFixed(4)),
    injectionFixtures: to.injectionFixtures,
  };
}

export interface ResistanceWatchResult {
  checked: boolean;
  dropped: boolean;
  alerted: boolean; // false when the drop was already alerted (dedup)
}

// The bucket source is injectable so tests can exercise the alert/dedup logic
// without depending on whatever eval runs other test files have stored (the
// same isolation trick as the watchdog's WatchdogDeps).
export interface ResistanceWatchDeps {
  months: () => Promise<ResistanceMonth[]>;
}

const realDeps: ResistanceWatchDeps = { months: injectionResistanceMonths };

// One alert per degraded month: the append-only audit ledger doubles as the
// dedup key (entity_id = the month that dropped), so every instance can run
// the sweep and the second pass is a no-op — same idempotence-by-construction
// posture as the other sweeps.
export async function sweepResistanceWatch(
  deps: ResistanceWatchDeps = realDeps,
): Promise<ResistanceWatchResult> {
  return runInBypassContext(async () => {
    const drop = detectResistanceDrop(await deps.months());
    if (!drop) return { checked: true, dropped: false, alerted: false };

    const [existing] = await getDb()
      .select({ seq: auditEventsTable.seq })
      .from(auditEventsTable)
      .where(
        and(
          eq(auditEventsTable.action, RESISTANCE_DROP_ACTION),
          eq(auditEventsTable.entityId, drop.toMonth),
        ),
      )
      .orderBy(desc(auditEventsTable.seq))
      .limit(1);
    if (existing) return { checked: true, dropped: true, alerted: false };

    await appendAudit({
      actorId: "resistance-watch",
      actorRole: "system",
      action: RESISTANCE_DROP_ACTION,
      entityType: "clerk_eval",
      entityId: drop.toMonth,
      after: {
        fromMonth: drop.fromMonth,
        toMonth: drop.toMonth,
        fromRate: drop.fromRate,
        toRate: drop.toRate,
        injectionFixtures: drop.injectionFixtures,
        reason:
          "Injection resistance fell materially below the previous measured month; review the eval runs and recent prompt changes on the Clerk health page.",
      },
    });
    logger.error(
      { ...drop },
      "Injection resistance DROPPED month-over-month: review Clerk health (eval runs, recent prompt changes, red-team fixtures) before promoting anything.",
    );
    return { checked: true, dropped: true, alerted: true };
  });
}

registerSweep(sweepResistanceWatch);
