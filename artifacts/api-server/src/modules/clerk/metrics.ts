import { sql } from "drizzle-orm";
import { getDb } from "@workspace/db";

// Clerk operational metrics (CLK-OBS-04, CLK-OPS-06/07). Pure SQL aggregation
// over the case table and the append-only inference ledger — the numbers the
// monthly governance review needs (invalid-output rate, refusal rate, latency
// by model/prompt cohort, decision throughput), computed on demand. No model
// involvement, no new state.

export interface ClerkMetrics {
  windowDays: number;
  cases: {
    total: number;
    byStatus: Record<string, number>;
    byKind: Record<string, number>;
    avgDecisionMinutes: number | null;
    avgQueueWaitMinutes: number | null;
    avgActiveReviewMinutes: number | null;
  };
  inference: {
    total: number;
    byOutcome: Record<string, number>;
    invalidRate: number;
    errorRate: number;
    latencyP50Ms: number | null;
    latencyP95Ms: number | null;
    cohorts: {
      model: string;
      promptVersion: string;
      purpose: string;
      total: number;
      okCount: number;
      latencyP95Ms: number | null;
    }[];
  };
  corrections: {
    field: string;
    total: number;
    overridden: number;
    overrideRate: number;
  }[];
  ask: {
    total: number;
    answered: number;
    refused: number;
    refusalRate: number;
  };
}

function rate(part: number, whole: number): number {
  return whole === 0 ? 0 : Number((part / whole).toFixed(4));
}

export async function getClerkMetrics(
  windowDays = 30,
): Promise<ClerkMetrics> {
  const db = getDb();
  const since = sql`now() - make_interval(days => ${windowDays})`;

  const caseRows = (
    await db.execute(sql`
      SELECT kind, status, COUNT(*)::int AS count
      FROM clerk_cases
      WHERE created_at >= ${since}
      GROUP BY kind, status
    `)
  ).rows as { kind: string; status: string; count: number }[];

  const byStatus: Record<string, number> = {};
  const byKind: Record<string, number> = {};
  let total = 0;
  for (const r of caseRows) {
    total += r.count;
    byStatus[r.status] = (byStatus[r.status] ?? 0) + r.count;
    byKind[r.kind] = (byKind[r.kind] ?? 0) + r.count;
  }

  // Median human turnaround for decided extraction cases: creation (intake +
  // machine extraction) to the recorded decision. updated_at is the decision
  // write because decided cases take no further writes.
  const decisionRows = (
    await db.execute(sql`
      SELECT AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) / 60.0) AS avg_minutes
      FROM clerk_cases
      WHERE created_at >= ${since}
        AND kind = 'extraction'
        AND decided_by IS NOT NULL
    `)
  ).rows as { avg_minutes: string | null }[];
  const avgDecisionMinutes =
    decisionRows[0]?.avg_minutes != null
      ? Number(Number(decisionRows[0].avg_minutes).toFixed(1))
      : null;

  // Claim timestamps split turnaround into queue-wait (created -> claimed) and
  // active review (claimed -> decision) — the CLK-OPS-06 operator-time signal.
  const timingRows = (
    await db.execute(sql`
      SELECT
        AVG(EXTRACT(EPOCH FROM (claimed_at - created_at)) / 60.0)
          AS queue_minutes,
        AVG(EXTRACT(EPOCH FROM (updated_at - claimed_at)) / 60.0)
          FILTER (WHERE decided_by IS NOT NULL) AS active_minutes
      FROM clerk_cases
      WHERE created_at >= ${since}
        AND kind = 'extraction'
        AND claimed_at IS NOT NULL
    `)
  ).rows as { queue_minutes: string | null; active_minutes: string | null }[];
  const avgQueueWaitMinutes =
    timingRows[0]?.queue_minutes != null
      ? Number(Number(timingRows[0].queue_minutes).toFixed(1))
      : null;
  const avgActiveReviewMinutes =
    timingRows[0]?.active_minutes != null
      ? Number(Number(timingRows[0].active_minutes).toFixed(1))
      : null;

  // Per-field override rates from the correction exhaust: how often the
  // operator changed each field the model proposed (approved cases only).
  const correctionRows = (
    await db.execute(sql`
      SELECT
        c ->> 'field' AS field,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE (c ->> 'changed')::boolean)::int AS overridden
      FROM clerk_cases, LATERAL jsonb_array_elements(corrections) AS c
      WHERE created_at >= ${since} AND corrections IS NOT NULL
      GROUP BY 1
      ORDER BY 3 DESC, 1
    `)
  ).rows as { field: string; total: number; overridden: number }[];

  const inferenceRows = (
    await db.execute(sql`
      SELECT outcome, COUNT(*)::int AS count
      FROM clerk_inference_calls
      WHERE created_at >= ${since}
      GROUP BY outcome
    `)
  ).rows as { outcome: string; count: number }[];
  const byOutcome: Record<string, number> = {};
  let inferenceTotal = 0;
  for (const r of inferenceRows) {
    inferenceTotal += r.count;
    byOutcome[r.outcome] = r.count;
  }

  const latencyRows = (
    await db.execute(sql`
      SELECT
        percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95
      FROM clerk_inference_calls
      WHERE created_at >= ${since} AND latency_ms IS NOT NULL
    `)
  ).rows as { p50: string | null; p95: string | null }[];

  const cohortRows = (
    await db.execute(sql`
      SELECT
        model,
        prompt_version,
        purpose,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE outcome = 'ok')::int AS ok_count,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95
      FROM clerk_inference_calls
      WHERE created_at >= ${since}
      GROUP BY model, prompt_version, purpose
      ORDER BY total DESC
      LIMIT 50
    `)
  ).rows as {
    model: string;
    prompt_version: string;
    purpose: string;
    total: number;
    ok_count: number;
    p95: string | null;
  }[];

  // Ask outcomes come from the answer payload: answered=true means a claim
  // rendered; everything else was a refusal-and-escalate.
  const askRows = (
    await db.execute(sql`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE (answer ->> 'answered') = 'true')::int AS answered
      FROM clerk_cases
      WHERE created_at >= ${since} AND kind = 'question'
    `)
  ).rows as { total: number; answered: number }[];
  const askTotal = askRows[0]?.total ?? 0;
  const answered = askRows[0]?.answered ?? 0;

  return {
    windowDays,
    cases: {
      total,
      byStatus,
      byKind,
      avgDecisionMinutes,
      avgQueueWaitMinutes,
      avgActiveReviewMinutes,
    },
    inference: {
      total: inferenceTotal,
      byOutcome,
      invalidRate: rate(byOutcome["invalid_discarded"] ?? 0, inferenceTotal),
      errorRate: rate(byOutcome["error"] ?? 0, inferenceTotal),
      // != null, not truthiness: a 0 ms percentile is a real value.
      latencyP50Ms:
        latencyRows[0]?.p50 != null
          ? Math.round(Number(latencyRows[0].p50))
          : null,
      latencyP95Ms:
        latencyRows[0]?.p95 != null
          ? Math.round(Number(latencyRows[0].p95))
          : null,
      cohorts: cohortRows.map((c) => ({
        model: c.model,
        promptVersion: c.prompt_version,
        purpose: c.purpose,
        total: c.total,
        okCount: c.ok_count,
        latencyP95Ms: c.p95 != null ? Math.round(Number(c.p95)) : null,
      })),
    },
    corrections: correctionRows.map((c) => ({
      field: c.field,
      total: c.total,
      overridden: c.overridden,
      overrideRate: rate(c.overridden, c.total),
    })),
    ask: {
      total: askTotal,
      answered,
      refused: askTotal - answered,
      refusalRate: rate(askTotal - answered, askTotal),
    },
  };
}
