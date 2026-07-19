import { sql } from "drizzle-orm";
import { getDb } from "@workspace/db";
import { isFeatureEnabled } from "../flags/flags";
import { CLERK_FLAG_KEY } from "../clerk/gateway";
import {
  detectResistanceDrop,
  injectionResistanceMonths,
} from "../clerk/resistance-watch";
import { detectSpendAnomalies, firmSpendDays } from "../clerk/spend-watch";
import { UNMAPPED_TITLE_PREFIX } from "./sweeps";

// Operator daily brief (round-12 idea #1). The firm side has the weekly
// digest; the desk starts its day with tab-hopping. One deterministic
// platform-wide summary — "what needs me first" — computed on demand from
// tables that all exist. Zero model calls, nothing stored. Operator surface
// (operator.queue.act), so platform-wide numbers are in scope by design.

export interface OperatorBrief {
  asOf: string;
  // Actionable queues, oldest-waiting named so triage starts concrete.
  openCases: {
    byPriority: { priority: string; count: number }[];
    oldestTitle: string | null;
    oldestOpenedAt: string | null;
  };
  unansweredEscalations: {
    count: number;
    oldestReason: string | null;
    oldestRaisedAt: string | null;
  };
  stuckBatches: { count: number; oldestQueuedAt: string | null };
  unmappedCodeCases: number;
  // Platform state worth knowing before acting.
  clerkEnabled: boolean;
  resistanceAlert: boolean;
  // Firms whose latest-day Clerk spend is anomalously above their own
  // trailing baseline (same detector as the spend-watch sweep).
  spendAlerts: number;
  // Yesterday's throughput (Lagos day) — the "did the desk keep up" number.
  decidedYesterday: number;
}

export async function computeOperatorBrief(
  now: Date = new Date(),
): Promise<OperatorBrief> {
  const db = getDb();

  const caseRows = (
    await db.execute<{ priority: string; count: number }>(sql`
      SELECT priority, COUNT(*)::int AS count
      FROM operator_cases
      WHERE status IN ('open', 'in_progress')
      GROUP BY priority
      ORDER BY count DESC
    `)
  ).rows;
  const oldestCase = (
    await db.execute<{ title: string; opened_at: string }>(sql`
      SELECT title, opened_at::text AS opened_at
      FROM operator_cases
      WHERE status IN ('open', 'in_progress')
      ORDER BY opened_at ASC
      LIMIT 1
    `)
  ).rows[0];

  // One pass: the count plus the oldest ROW (id tiebreaker so reason and
  // timestamp can never come from two different created_at-tied rows).
  const escalationRows = (
    await db.execute<{
      count: number;
      oldest_reason: string | null;
      oldest_at: string | null;
    }>(sql`
      SELECT COUNT(*)::int AS count,
        (array_agg(reason ORDER BY created_at ASC, id ASC))[1] AS oldest_reason,
        (array_agg(created_at ORDER BY created_at ASC, id ASC))[1]::text AS oldest_at
      FROM escalations
      WHERE operator_reply IS NULL AND status IN ('open', 'acknowledged')
    `)
  ).rows;

  const batchRows = (
    await db.execute<{ count: number; oldest: string | null }>(sql`
      SELECT COUNT(*)::int AS count, MIN(created_at)::text AS oldest
      FROM clerk_batches
      WHERE status IN ('queued', 'processing')
    `)
  ).rows;

  const unmappedRows = (
    await db.execute<{ count: number }>(sql`
      SELECT COUNT(*)::int AS count
      FROM operator_cases
      WHERE status IN ('open', 'in_progress')
        AND title LIKE ${`${UNMAPPED_TITLE_PREFIX}%`}
    `)
  ).rows;

  // Yesterday on the Lagos calendar — the desk's statutory day, like every
  // other "today" on the platform. `now` feeds the SQL (not just asOf) so
  // the boundary is pinnable in tests.
  const decidedRows = (
    await db.execute<{ count: number }>(sql`
      SELECT COUNT(*)::int AS count
      FROM clerk_cases
      WHERE kind = 'extraction'
        AND decided_by IS NOT NULL
        AND (updated_at AT TIME ZONE 'Africa/Lagos')::date
          = (${now.toISOString()}::timestamptz AT TIME ZONE 'Africa/Lagos')::date - 1
    `)
  ).rows;

  const resistance = detectResistanceDrop(await injectionResistanceMonths());
  const spendAnomalies = detectSpendAnomalies(await firmSpendDays());

  return {
    asOf: now.toISOString(),
    openCases: {
      byPriority: caseRows.map((r) => ({
        priority: r.priority,
        count: Number(r.count),
      })),
      oldestTitle: oldestCase?.title ?? null,
      oldestOpenedAt: oldestCase?.opened_at ?? null,
    },
    unansweredEscalations: {
      count: Number(escalationRows[0]?.count ?? 0),
      oldestReason: escalationRows[0]?.oldest_reason ?? null,
      oldestRaisedAt: escalationRows[0]?.oldest_at ?? null,
    },
    stuckBatches: {
      count: Number(batchRows[0]?.count ?? 0),
      oldestQueuedAt: batchRows[0]?.oldest ?? null,
    },
    unmappedCodeCases: Number(unmappedRows[0]?.count ?? 0),
    clerkEnabled: await isFeatureEnabled(CLERK_FLAG_KEY),
    resistanceAlert: resistance !== null,
    spendAlerts: spendAnomalies.length,
    decidedYesterday: Number(decidedRows[0]?.count ?? 0),
  };
}
