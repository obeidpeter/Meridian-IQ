import { and, eq, sql } from "drizzle-orm";
import { getDb, runInBypassContext, auditEventsTable } from "@workspace/db";
import { logger } from "../../lib/logger";
import { appendAudit } from "../audit/audit";
import { registerSweep } from "../pipeline/pipeline";

// Kept-rate drift watch — the accuracy sibling of resistance-watch.ts. The
// corrections exhaust (every field an operator kept or overrode at approval)
// is the honest measure of extraction quality, but the calibration table is a
// chart someone has to look at; a model regression, a provider swap or a new
// document mix can erode the kept-rate for weeks before operators name it.
// This sweep runs the SAME monthly buckets as the health page's kept-rate
// trend and raises a durable alert — an audit event plus an error-level log
// line — the first time a month's kept-rate falls materially below the
// previous measured month. Pure rules over stored corrections: zero model
// calls, and like the resistance watch it takes no automatic action (a
// quality dip needs a human judgement, not a kill switch).
//
// Thresholds are env-tunable and deliberately need a real sample: a month
// with a handful of compared fields produces rates too noisy to alert on.

// A malformed value (empty string → 0, garbage → NaN) must never produce
// NaN rates or a permanently-silent watch — fall back to the default instead.
function envThreshold(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const MIN_FIELDS = envThreshold(process.env.QUALITY_ALERT_MIN_FIELDS, 50);
const DROP_POINTS = envThreshold(process.env.QUALITY_ALERT_DROP_POINTS, 0.1);

export const QUALITY_DROP_ACTION = "clerk.quality.drop";

export interface KeptRateMonth {
  month: string; // "YYYY-MM" (UTC)
  fields: number; // correction entries compared in the month
  keptRate: number; // share the operator left unchanged (changed=false)
}

export interface QualityDrop {
  fromMonth: string;
  toMonth: string;
  fromRate: number;
  toRate: number;
  fields: number; // the degraded month's sample size
}

// The trend chart's month buckets — one query, shared with getClerkMetrics so
// the alert and the chart can never disagree. Source mirrors the calibration
// sample in metrics.ts (approved extraction cases with a corrections diff —
// header AND line entries live in the same `corrections` jsonb array), and
// the decision timestamp is `updated_at` (the decision write; decided cases
// take no further writes — the same expression as avgDecisionMinutes), with
// the injection trend's to_char/date_trunc month bucketing.
export async function keptRateMonths(monthsBack = 5): Promise<KeptRateMonth[]> {
  const rows = (
    await getDb().execute<{
      month: string;
      fields: number;
      kept: number;
    }>(sql`
      SELECT to_char(date_trunc('month', c.updated_at), 'YYYY-MM') AS month,
        COUNT(*)::int AS fields,
        COUNT(*) FILTER (WHERE NOT (cor ->> 'changed')::boolean)::int AS kept
      FROM clerk_cases c, LATERAL jsonb_array_elements(c.corrections) AS cor
      WHERE c.kind = 'extraction'
        AND c.status = 'approved'
        AND c.corrections IS NOT NULL
        AND c.updated_at >= date_trunc('month', now()) - make_interval(months => ${monthsBack})
      GROUP BY 1
      ORDER BY 1
    `)
  ).rows;
  return rows.map((r) => {
    const fields = Number(r.fields);
    return {
      month: r.month,
      fields,
      keptRate: fields > 0 ? Number((Number(r.kept) / fields).toFixed(4)) : 0,
    };
  });
}

export interface QualityThresholds {
  minFields: number;
  dropPoints: number;
}

// Pure detection, exported for tests: compare the two NEWEST months that each
// carry a real sample (>= minFields compared fields — thin months are
// skipped, not compared). A kept-rate drop of dropPoints or more between
// them alerts.
export function detectQualityDrop(
  months: KeptRateMonth[],
  thresholds: QualityThresholds = {
    minFields: MIN_FIELDS,
    dropPoints: DROP_POINTS,
  },
): QualityDrop | null {
  const measured = [...months]
    .sort((a, b) => a.month.localeCompare(b.month))
    .filter((m) => m.fields >= thresholds.minFields);
  if (measured.length < 2) return null;
  const from = measured[measured.length - 2];
  const to = measured[measured.length - 1];
  if (from.keptRate - to.keptRate < thresholds.dropPoints) return null;
  return {
    fromMonth: from.month,
    toMonth: to.month,
    fromRate: from.keptRate,
    toRate: to.keptRate,
    fields: to.fields,
  };
}

export interface QualityWatchResult {
  checked: boolean;
  dropped: boolean;
  alerted: boolean; // false when the drop was already alerted (dedup)
}

// The bucket source is injectable so tests can exercise the alert/dedup logic
// without depending on whatever approved cases other test files have stored
// (the same isolation trick as ResistanceWatchDeps).
export interface QualityWatchDeps {
  months: () => Promise<KeptRateMonth[]>;
}

const realDeps: QualityWatchDeps = { months: keptRateMonths };

// One alert per degraded month: the append-only audit ledger is the durable
// cross-instance dedup key (entity_id = the month that dropped), fronted by
// an in-process cache so the month-long tail of a detected drop doesn't
// re-query the ledger every sweep minute. Two instances FIRST detecting the
// same drop simultaneously can, in the worst case, both append (the audit
// advisory lock serializes the appends, not the check-then-append) — a
// harmless duplicate history row, accepted rather than adding a lock.
const alertedMonths = new Set<string>();

export async function sweepQualityWatch(
  deps: QualityWatchDeps = realDeps,
): Promise<QualityWatchResult> {
  return runInBypassContext(async () => {
    const drop = detectQualityDrop(await deps.months());
    if (!drop) return { checked: true, dropped: false, alerted: false };
    if (alertedMonths.has(drop.toMonth)) {
      return { checked: true, dropped: true, alerted: false };
    }

    const [existing] = await getDb()
      .select({ seq: auditEventsTable.seq })
      .from(auditEventsTable)
      .where(
        and(
          eq(auditEventsTable.action, QUALITY_DROP_ACTION),
          eq(auditEventsTable.entityId, drop.toMonth),
        ),
      )
      .limit(1);
    if (existing) {
      alertedMonths.add(drop.toMonth);
      return { checked: true, dropped: true, alerted: false };
    }

    await appendAudit({
      actorId: "quality-watch",
      actorRole: "system",
      action: QUALITY_DROP_ACTION,
      entityType: "clerk_quality",
      entityId: drop.toMonth,
      after: {
        fromMonth: drop.fromMonth,
        toMonth: drop.toMonth,
        fromRate: drop.fromRate,
        toRate: drop.toRate,
        fields: drop.fields,
        reason:
          "Extraction kept-rate fell materially below the previous measured month; review the corrections exhaust and recent model/prompt changes on the Clerk health page.",
      },
    });
    logger.error(
      { ...drop },
      "Extraction kept-rate DROPPED month-over-month: review Clerk health (corrections exhaust, calibration, recent model or prompt changes) before trusting new extractions unreviewed.",
    );
    alertedMonths.add(drop.toMonth);
    return { checked: true, dropped: true, alerted: true };
  });
}

registerSweep(sweepQualityWatch);
