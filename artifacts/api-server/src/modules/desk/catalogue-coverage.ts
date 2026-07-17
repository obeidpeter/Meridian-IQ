import { sql } from "drizzle-orm";
import { getDb } from "@workspace/db";

// Catalogue coverage report (round-13 idea #5). INT-02 promises that
// unmapped rail errors "alert operators and enter the catalogue within one
// working day", and that the unmapped rate stays low — but nothing measured
// it. This is the measurement: pure SQL over submission attempts and the
// catalogue, platform-wide (the catalogue is global reference data), zero
// model calls, nothing stored.
//  - coverage: how many rejected attempts in the window carried a code the
//    catalogue maps TODAY (current-state coverage, not as-of-attempt);
//  - the currently-unmapped codes, oldest first sighting first, each with
//    whether an open "Unmapped code" desk case is tracking it;
//  - the mapping SLA: for catalogue entries created in the trailing period
//    that were SEEN before they were mapped, how long the gap was — the
//    within-one-day share is the INT-02 number. Entries mapped before any
//    sighting (or never sighted) are proactive and never judged by the SLA.

const WINDOW_DAYS = 90;
const SLA_WINDOW_DAYS = 180;
const MAX_UNMAPPED_ROWS = 20;
const MAX_RECENT_MAPPINGS = 10;

export interface UnmappedCodeRow {
  code: string;
  occurrences: number;
  firstSeen: string;
  lastSeen: string;
  openCase: boolean;
}

export interface RecentMappingRow {
  code: string;
  firstSeen: string;
  mappedAt: string;
  daysToMap: number;
}

export interface CatalogueCoverageReport {
  windowDays: number;
  slaWindowDays: number;
  // Rejected attempts in the window that carried an error code…
  rejectedAttempts: number;
  // …of which this many carry a code the catalogue maps today.
  mappedAttempts: number;
  mappedShare: number | null;
  // Rejected attempts with NO code at all (never mappable — its own bucket).
  uncodedRejections: number;
  distinctCodes: number;
  mappedCodes: number;
  openUnmapped: UnmappedCodeRow[];
  unmappedTruncated: boolean;
  sla: {
    // Entries created in the SLA window that were seen before being mapped.
    judged: number;
    avgDaysToMap: number | null;
    maxDaysToMap: number | null;
    // INT-02: share of judged entries mapped within one day of first sighting.
    withinOneDayShare: number | null;
    // Entries created in the SLA window before (or without) any sighting.
    proactive: number;
  };
  recentMappings: RecentMappingRow[];
}

export async function computeCatalogueCoverage(): Promise<CatalogueCoverageReport> {
  const db = getDb();
  const windowStart = sql`now() - make_interval(days => ${WINDOW_DAYS})`;

  const [agg] = (
    await db.execute<{
      coded: number;
      mapped: number;
      uncoded: number;
      distinct_codes: number;
      mapped_codes: number;
    }>(sql`
      SELECT
        COUNT(*) FILTER (WHERE sa.error_code IS NOT NULL)::int AS coded,
        COUNT(*) FILTER (
          WHERE sa.error_code IS NOT NULL
            AND EXISTS (SELECT 1 FROM error_catalogue ec WHERE ec.code = sa.error_code)
        )::int AS mapped,
        COUNT(*) FILTER (WHERE sa.error_code IS NULL)::int AS uncoded,
        COUNT(DISTINCT sa.error_code)::int AS distinct_codes,
        COUNT(DISTINCT sa.error_code) FILTER (
          WHERE EXISTS (SELECT 1 FROM error_catalogue ec WHERE ec.code = sa.error_code)
        )::int AS mapped_codes
      FROM submission_attempts sa
      WHERE sa.status = 'rejected'
        AND sa.created_at >= ${windowStart}
    `)
  ).rows;

  // Currently-unmapped codes seen in the window. First sighting is over ALL
  // time (the age of the mapping debt, not of the window), and an open
  // "Unmapped code" desk case means the INT-02 sweep is already tracking it.
  const unmappedRows = (
    await db.execute<{
      code: string;
      occurrences: number;
      first_seen: string;
      last_seen: string;
      open_case: boolean;
    }>(sql`
      SELECT
        sa.error_code AS code,
        COUNT(*)::int AS occurrences,
        (SELECT MIN(s2.created_at) FROM submission_attempts s2
          WHERE s2.error_code = sa.error_code)::text AS first_seen,
        MAX(sa.created_at)::text AS last_seen,
        EXISTS (
          SELECT 1 FROM operator_cases oc
          WHERE oc.error_code = sa.error_code
            AND oc.title LIKE 'Unmapped code %'
            AND oc.status IN ('open', 'in_progress')
        ) AS open_case
      FROM submission_attempts sa
      WHERE sa.status = 'rejected'
        AND sa.created_at >= ${windowStart}
        AND sa.error_code IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM error_catalogue ec WHERE ec.code = sa.error_code)
      GROUP BY sa.error_code
      ORDER BY MIN(sa.created_at) ASC
      LIMIT ${MAX_UNMAPPED_ROWS + 1}
    `)
  ).rows;
  const unmappedTruncated = unmappedRows.length > MAX_UNMAPPED_ROWS;
  const openUnmapped: UnmappedCodeRow[] = unmappedRows
    .slice(0, MAX_UNMAPPED_ROWS)
    .map((r) => ({
      code: r.code,
      occurrences: Number(r.occurrences),
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
      openCase: Boolean(r.open_case),
    }));

  // Mapping SLA: catalogue entries created in the SLA window, joined to the
  // first rejected sighting of their code. Seen-before-mapped entries are
  // judged; the rest were mapped proactively and have no gap to measure.
  const slaRows = (
    await db.execute<{
      code: string;
      created_at: string;
      first_seen: string | null;
      // Gap in fractional days, SQL-computed (no JS timestamp parsing);
      // negative or null = mapped before any sighting (proactive).
      gap_days: number | null;
    }>(sql`
      SELECT
        ec.code,
        ec.created_at::text AS created_at,
        fs.first_seen::text AS first_seen,
        (EXTRACT(EPOCH FROM ec.created_at - fs.first_seen) / 86400)::float8 AS gap_days
      FROM error_catalogue ec
      LEFT JOIN LATERAL (
        SELECT MIN(sa.created_at) AS first_seen FROM submission_attempts sa
        WHERE sa.error_code = ec.code AND sa.status = 'rejected'
      ) fs ON true
      WHERE ec.created_at >= now() - make_interval(days => ${SLA_WINDOW_DAYS})
      ORDER BY ec.created_at DESC
    `)
  ).rows;

  const judged = slaRows
    .filter((r) => r.gap_days !== null && Number(r.gap_days) > 0)
    .map((r) => ({
      code: r.code,
      firstSeen: r.first_seen!,
      mappedAt: r.created_at,
      daysToMap: Number(r.gap_days),
    }));
  const proactive = slaRows.length - judged.length;

  const round1 = (n: number) => Math.round(n * 10) / 10;
  const coded = Number(agg?.coded ?? 0);
  return {
    windowDays: WINDOW_DAYS,
    slaWindowDays: SLA_WINDOW_DAYS,
    rejectedAttempts: coded,
    mappedAttempts: Number(agg?.mapped ?? 0),
    mappedShare:
      coded > 0 ? Math.round((Number(agg?.mapped ?? 0) / coded) * 10000) / 10000 : null,
    uncodedRejections: Number(agg?.uncoded ?? 0),
    distinctCodes: Number(agg?.distinct_codes ?? 0),
    mappedCodes: Number(agg?.mapped_codes ?? 0),
    openUnmapped,
    unmappedTruncated,
    sla: {
      judged: judged.length,
      avgDaysToMap:
        judged.length > 0
          ? round1(judged.reduce((s, r) => s + r.daysToMap, 0) / judged.length)
          : null,
      maxDaysToMap:
        judged.length > 0 ? round1(Math.max(...judged.map((r) => r.daysToMap))) : null,
      withinOneDayShare:
        judged.length > 0
          ? Math.round(
              (judged.filter((r) => r.daysToMap <= 1).length / judged.length) * 10000,
            ) / 10000
          : null,
      proactive,
    },
    recentMappings: judged.slice(0, MAX_RECENT_MAPPINGS).map((r) => ({
      code: r.code,
      firstSeen: r.firstSeen,
      mappedAt: r.mappedAt,
      daysToMap: round1(r.daysToMap),
    })),
  };
}
