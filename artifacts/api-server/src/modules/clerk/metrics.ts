import { sql } from "drizzle-orm";
import {
  getDb,
  type ClerkCorrection,
  type ClerkExtraction,
} from "@workspace/db";

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
  cost: {
    promptTokens: number;
    completionTokens: number;
    callsWithUsage: number;
    tokensPerDecidedCase: number | null;
    estimatedUsd: number | null;
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
  // Confidence calibration from the corrections exhaust (idea #5): for each
  // confidence band, how often the operator KEPT the model's value unchanged.
  // Well-calibrated extraction shows keptRate tracking meanConfidence; a band
  // where they diverge tells the governance review the flagging threshold
  // (FLAG_CONFIDENCE_THRESHOLD) is set against miscalibrated numbers. Absent
  // when the window holds no corrected approvals.
  calibration?: {
    sampleFields: number;
    buckets: {
      range: string;
      fields: number;
      meanConfidence: number;
      keptRate: number;
    }[];
  };
}

// Pure calibration fold, separately testable: join each approved case's
// header-field confidences (extraction) with whether the operator changed the
// value (corrections diff, matched by field name). Line fields are excluded —
// positional pairing makes their confidence attribution unreliable.
const CALIBRATION_BANDS = [
  { range: "0.0-0.5", min: 0, max: 0.5 },
  { range: "0.5-0.8", min: 0.5, max: 0.8 },
  { range: "0.8-1.0", min: 0.8, max: 1.0000001 },
];

export function computeCalibration(
  cases: {
    extraction: ClerkExtraction | null;
    corrections: ClerkCorrection[] | null;
  }[],
): NonNullable<ClerkMetrics["calibration"]> | undefined {
  const acc = CALIBRATION_BANDS.map(() => ({
    fields: 0,
    confidenceSum: 0,
    kept: 0,
  }));
  for (const kase of cases) {
    if (!kase.extraction || !kase.corrections) continue;
    const changedByField = new Map(
      kase.corrections
        .filter((c) => !c.field.startsWith("lines."))
        .map((c) => [c.field, c.changed]),
    );
    for (const field of kase.extraction.fields) {
      const changed = changedByField.get(field.field);
      if (changed === undefined) continue; // field not compared at approval
      const band = CALIBRATION_BANDS.findIndex(
        (b) => field.confidence >= b.min && field.confidence < b.max,
      );
      if (band === -1) continue;
      acc[band].fields += 1;
      acc[band].confidenceSum += field.confidence;
      if (!changed) acc[band].kept += 1;
    }
  }
  const sampleFields = acc.reduce((n, b) => n + b.fields, 0);
  if (sampleFields === 0) return undefined;
  return {
    sampleFields,
    buckets: CALIBRATION_BANDS.map((band, i) => ({
      range: band.range,
      fields: acc[i].fields,
      meanConfidence:
        acc[i].fields === 0
          ? 0
          : Number((acc[i].confidenceSum / acc[i].fields).toFixed(4)),
      keptRate: acc[i].fields === 0 ? 0 : rate(acc[i].kept, acc[i].fields),
    })),
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

  // Cost-to-serve (CLK-NFR-04): token totals from the ledger's usage columns.
  // Older rows predate usage capture, so callsWithUsage says how much of the
  // window the totals actually cover. Sums come back as bigint strings.
  const costRows = (
    await db.execute(sql`
      SELECT
        COALESCE(SUM(prompt_tokens), 0)::bigint AS prompt_tokens,
        COALESCE(SUM(completion_tokens), 0)::bigint AS completion_tokens,
        COUNT(*) FILTER (
          WHERE prompt_tokens IS NOT NULL OR completion_tokens IS NOT NULL
        )::int AS calls_with_usage
      FROM clerk_inference_calls
      WHERE created_at >= ${since}
    `)
  ).rows as {
    prompt_tokens: string;
    completion_tokens: string;
    calls_with_usage: number;
  }[];
  const promptTokens = Number(costRows[0]?.prompt_tokens ?? 0);
  const completionTokens = Number(costRows[0]?.completion_tokens ?? 0);
  const callsWithUsage = costRows[0]?.calls_with_usage ?? 0;

  // Tokens per decided extraction case: only cases whose ledger calls carry
  // usage data enter the denominator, so partial capture doesn't skew the
  // per-case number downward.
  const perCaseRows = (
    await db.execute(sql`
      SELECT
        COUNT(DISTINCT c.id)::int AS decided_cases,
        (COALESCE(SUM(i.prompt_tokens), 0)
          + COALESCE(SUM(i.completion_tokens), 0))::bigint AS tokens
      FROM clerk_cases c
      JOIN clerk_inference_calls i ON i.case_id = c.id
      WHERE c.created_at >= ${since}
        AND c.kind = 'extraction'
        AND c.decided_by IS NOT NULL
        AND (i.prompt_tokens IS NOT NULL OR i.completion_tokens IS NOT NULL)
    `)
  ).rows as { decided_cases: number; tokens: string }[];
  const decidedWithUsage = perCaseRows[0]?.decided_cases ?? 0;
  const tokensPerDecidedCase =
    decidedWithUsage > 0
      ? Number(
          (Number(perCaseRows[0]!.tokens) / decidedWithUsage).toFixed(1),
        )
      : null;

  // USD estimate only when the operator has configured both per-million-token
  // rates; a half-configured or unconfigured environment reports null rather
  // than a misleading partial figure.
  const inputRate = Number(process.env.CLERK_COST_PER_1M_INPUT_USD);
  const outputRate = Number(process.env.CLERK_COST_PER_1M_OUTPUT_USD);
  const estimatedUsd =
    Number.isFinite(inputRate) && Number.isFinite(outputRate)
      ? Number(
          (
            (promptTokens / 1_000_000) * inputRate +
            (completionTokens / 1_000_000) * outputRate
          ).toFixed(4),
        )
      : null;

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

  // Calibration input: recent approved extractions with a corrections diff.
  // Bounded (newest 500) so the fold stays cheap as history grows.
  const calibrationRows = (
    await db.execute(sql`
      SELECT extraction, corrections
      FROM clerk_cases
      WHERE created_at >= ${since}
        AND kind = 'extraction'
        AND status = 'approved'
        AND extraction IS NOT NULL
        AND corrections IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 500
    `)
  ).rows as {
    extraction: ClerkExtraction | null;
    corrections: ClerkCorrection[] | null;
  }[];
  const calibration = computeCalibration(calibrationRows);

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
    cost: {
      promptTokens,
      completionTokens,
      callsWithUsage,
      tokensPerDecidedCase,
      estimatedUsd,
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
    ...(calibration ? { calibration } : {}),
  };
}
