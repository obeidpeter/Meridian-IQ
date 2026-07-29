import { sql } from "drizzle-orm";
import { getDb } from "@workspace/db";

// Digest impact report (round-20 idea #6) — the reminder-effectiveness
// pattern pointed at the digest itself. The digest's own weekly fact
// snapshots (stored with each row since round 20) are the time series:
// for every pair of CONSECUTIVE weekly digests in one firm, how did the
// urgent count (overdue + failed) move, split by whether the earlier
// digest was actually DELIVERED to opted-in staff? Deterministic, nothing
// stored, and honest about what it is: delivered firms differ from
// undelivered firms in many ways (opt-in itself is a signal), so the note
// pins correlation-not-causation. Pairs must be exactly 7 days apart —
// a skipped week is not a week-over-week observation.

const MIN_PAIRS = 3;

export interface DigestImpactBucket {
  pairs: number;
  // Mean week-over-week change in overdue+failed counts (negative =
  // improving). Null under the pair floor.
  meanUrgentDelta: number | null;
  // Share of pairs where the urgent count FELL. Null under the pair floor.
  improvedShare: number | null;
}

export interface DigestImpactReport {
  delivered: DigestImpactBucket;
  undelivered: DigestImpactBucket;
  note: string;
}

const EMPTY: DigestImpactBucket = {
  pairs: 0,
  meanUrgentDelta: null,
  improvedShare: null,
};

// `onlyFirmId` is a TEST isolation hook: the production route always calls
// without it (the report is platform-wide by design), but exact assertions
// on a shared test database need a fence around the seeded firm.
export async function computeDigestImpact(
  onlyFirmId?: string,
): Promise<DigestImpactReport> {
  const firmFilter = onlyFirmId ? sql` AND firm_id = ${onlyFirmId}` : sql``;
  const rows = (
    await getDb().execute<{
      delivered: boolean;
      pairs: number;
      mean_delta: string | null;
      improved: number;
    }>(sql`
      WITH snapshots AS (
        SELECT firm_id, week_start,
          (delivered_at IS NOT NULL) AS delivered,
          COALESCE((facts->>'overdueCount')::int, 0)
            + COALESCE((facts->>'failedCount')::int, 0) AS urgent,
          LEAD(week_start) OVER w AS next_week,
          LEAD(
            COALESCE((facts->>'overdueCount')::int, 0)
              + COALESCE((facts->>'failedCount')::int, 0)
          ) OVER w AS next_urgent
        FROM clerk_digests
        WHERE facts IS NOT NULL${firmFilter}
        WINDOW w AS (PARTITION BY firm_id ORDER BY week_start)
      )
      SELECT delivered, COUNT(*)::int AS pairs,
        AVG(next_urgent - urgent)::text AS mean_delta,
        COUNT(*) FILTER (WHERE next_urgent < urgent)::int AS improved
      FROM snapshots
      WHERE next_week = week_start + interval '7 days'
        AND next_urgent IS NOT NULL
      GROUP BY 1
    `)
  ).rows;

  const bucket = (delivered: boolean): DigestImpactBucket => {
    const r = rows.find((row) => row.delivered === delivered);
    if (!r) return EMPTY;
    const pairs = Number(r.pairs);
    if (pairs < MIN_PAIRS) return { ...EMPTY, pairs };
    return {
      pairs,
      meanUrgentDelta:
        r.mean_delta !== null ? Number(r.mean_delta) : null,
      improvedShare: Number(r.improved) / pairs,
    };
  };

  return {
    delivered: bucket(true),
    undelivered: bucket(false),
    note:
      "Week-over-week movement of each firm's urgent count (overdue + failed) between consecutive weekly digests, split by whether the earlier digest was delivered to opted-in staff. " +
      `Pairs must be exactly 7 days apart; buckets under ${MIN_PAIRS} pairs show no rates. ` +
      "Correlation, not causation: firms that opt into delivery differ from firms that don't, and the digest is one nudge among many.",
  };
}
