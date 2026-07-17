import { and, eq, sql } from "drizzle-orm";
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

// A malformed value (empty string → 0, garbage → NaN) must never produce
// NaN rates (0/0 slips every comparison and would 500 the metrics parse) or
// a permanently-silent watch — fall back to the default instead.
function envThreshold(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const MIN_FIXTURES = envThreshold(process.env.RESISTANCE_ALERT_MIN_FIXTURES, 5);
const DROP_POINTS = envThreshold(process.env.RESISTANCE_ALERT_DROP, 0.1);

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

// One alert per degraded month: the append-only audit ledger is the durable
// cross-instance dedup key (entity_id = the month that dropped), fronted by
// an in-process cache so the month-long tail of a detected drop doesn't
// re-query the ledger every sweep minute. Two instances FIRST detecting the
// same drop simultaneously can, in the worst case, both append (the audit
// advisory lock serializes the appends, not the check-then-append) — a
// harmless duplicate history row, accepted rather than adding a lock.
const alertedMonths = new Set<string>();

export async function sweepResistanceWatch(
  deps: ResistanceWatchDeps = realDeps,
): Promise<ResistanceWatchResult> {
  return runInBypassContext(async () => {
    const drop = detectResistanceDrop(await deps.months());
    if (!drop) return { checked: true, dropped: false, alerted: false };
    if (alertedMonths.has(drop.toMonth)) {
      return { checked: true, dropped: true, alerted: false };
    }

    const [existing] = await getDb()
      .select({ seq: auditEventsTable.seq })
      .from(auditEventsTable)
      .where(
        and(
          eq(auditEventsTable.action, RESISTANCE_DROP_ACTION),
          eq(auditEventsTable.entityId, drop.toMonth),
        ),
      )
      .limit(1);
    if (existing) {
      alertedMonths.add(drop.toMonth);
      return { checked: true, dropped: true, alerted: false };
    }

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
    alertedMonths.add(drop.toMonth);
    return { checked: true, dropped: true, alerted: true };
  });
}

registerSweep(sweepResistanceWatch);
