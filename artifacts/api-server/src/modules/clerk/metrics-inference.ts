import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@workspace/db";
import { LEDGER_TOKENS_SQL, monthPace, utcMonthStart } from "./budget";
import { rate, type ClerkMetrics } from "./metrics-core";

// Clerk metrics — the clerk_inference_calls query group (R126, split from
// metrics.ts): outcome/latency cohorts, token cost totals, the ONE pricing
// rule, per-purpose economics and the platform spend meter. Each loader
// takes the façade's `since` SQL fragment unchanged and awaits its own
// queries in the original order.

export async function loadInferenceMetrics(
  since: SQL,
): Promise<ClerkMetrics["inference"]> {
  const db = getDb();
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

  return {
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
  };
}

// Cost-to-serve (CLK-NFR-04): token totals from the ledger's usage columns.
// Older rows predate usage capture, so callsWithUsage says how much of the
// window the totals actually cover. Sums come back as bigint strings.
export async function loadCostTotals(since: SQL): Promise<{
  promptTokens: number;
  completionTokens: number;
  callsWithUsage: number;
  tokensPerDecidedCase: number | null;
}> {
  const db = getDb();
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
      ? Number((Number(perCaseRows[0]!.tokens) / decidedWithUsage).toFixed(1))
      : null;

  return {
    promptTokens,
    completionTokens,
    callsWithUsage,
    tokensPerDecidedCase,
  };
}

// USD estimate only when the operator has configured both per-million-token
// rates; a half-configured or unconfigured environment reports null rather
// than a misleading partial figure. ONE spelling of the pricing rule — the
// headline cost, platform spend and per-purpose economics all price through
// this closure, so a rounding or rate-handling tweak lands everywhere.
// Known approximation (round 45): embed_memory (and round-47
// eval_retrieval) prompt tokens are priced at the COMPLETION input rate,
// which overstates embedding cost (~10x at current list prices).
// Acceptable while embedding spend is a sliver of the total; add a
// per-purpose rate if it ever becomes material.
// The env rates are read PER CALL (never at module load or cached): the
// façade invokes this inside getClerkMetrics, at the same point in the
// query sequence as before.
export function makeUsdEstimator(): (pt: number, ct: number) => number | null {
  const inputRate = Number(process.env.CLERK_COST_PER_1M_INPUT_USD);
  const outputRate = Number(process.env.CLERK_COST_PER_1M_OUTPUT_USD);
  const usdEstimate = (pt: number, ct: number): number | null =>
    Number.isFinite(inputRate) && Number.isFinite(outputRate)
      ? Number(
          (
            (pt / 1_000_000) * inputRate +
            (ct / 1_000_000) * outputRate
          ).toFixed(4),
        )
      : null;
  return usdEstimate;
}

// Unit economics: token spend per purpose inside the window (USD estimates
// reuse the same env rates as the headline figure — null when unconfigured)
// and the failure taxonomy over the trailing six UTC months.
export async function loadEconomics(
  since: SQL,
  usdEstimate: (pt: number, ct: number) => number | null,
): Promise<ClerkMetrics["economics"]> {
  const db = getDb();
  const purposeRows = (
    await db.execute(sql`
      SELECT
        purpose,
        COUNT(*)::int AS calls,
        COALESCE(SUM(prompt_tokens), 0)::bigint AS prompt_tokens,
        COALESCE(SUM(completion_tokens), 0)::bigint AS completion_tokens,
        COUNT(*) FILTER (WHERE outcome = 'error')::int AS error_count
      FROM clerk_inference_calls
      WHERE created_at >= ${since}
      GROUP BY purpose
      ORDER BY (COALESCE(SUM(prompt_tokens), 0) + COALESCE(SUM(completion_tokens), 0)) DESC
    `)
  ).rows as {
    purpose: string;
    calls: number;
    prompt_tokens: string;
    completion_tokens: string;
    error_count: number;
  }[];

  // Failure taxonomy over the trailing six UTC months (the budget month
  // boundary), independent of windowDays so the trend stays visible when the
  // operator narrows the window.
  const monthRows = (
    await db.execute(sql`
      SELECT
        to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
        COUNT(*)::int AS calls,
        COALESCE(SUM(prompt_tokens), 0)::bigint AS prompt_tokens,
        COALESCE(SUM(completion_tokens), 0)::bigint AS completion_tokens,
        COUNT(*) FILTER (WHERE outcome = 'ok')::int AS ok_count,
        COUNT(*) FILTER (WHERE outcome = 'invalid_discarded')::int AS invalid_count,
        COUNT(*) FILTER (WHERE outcome = 'killed')::int AS killed_count,
        COUNT(*) FILTER (WHERE outcome = 'error')::int AS error_count
      FROM clerk_inference_calls
      WHERE created_at >= date_trunc('month', now()) - interval '5 months'
      GROUP BY 1
      ORDER BY 1 DESC
    `)
  ).rows as {
    month: string;
    calls: number;
    prompt_tokens: string;
    completion_tokens: string;
    ok_count: number;
    invalid_count: number;
    killed_count: number;
    error_count: number;
  }[];

  return {
    byPurpose: purposeRows.map((p) => {
      const pt = Number(p.prompt_tokens);
      const ct = Number(p.completion_tokens);
      return {
        purpose: p.purpose,
        calls: p.calls,
        promptTokens: pt,
        completionTokens: ct,
        errorCount: p.error_count,
        estimatedUsd: usdEstimate(pt, ct),
      };
    }),
    months: monthRows.map((m) => ({
      month: m.month,
      calls: m.calls,
      promptTokens: Number(m.prompt_tokens),
      completionTokens: Number(m.completion_tokens),
      okCount: m.ok_count,
      invalidCount: m.invalid_count,
      killedCount: m.killed_count,
      errorCount: m.error_count,
    })),
  };
}

// Platform month-to-date spend, split by who funds the call (firm_id set
// = firm-funded; null = platform-funded desk/eval tooling). The month
// boundary is the SAME UTC month-start Date the budget uses, passed as a
// parameter so the two can never diverge. ONE `spendNow` Date serves the
// month start, the pace rule and the month label, so a call straddling a
// UTC month boundary can never mislabel the spend month.
export async function loadPlatformSpend(
  usdEstimate: (pt: number, ct: number) => number | null,
): Promise<ClerkMetrics["platformSpend"]> {
  const spendNow = new Date();
  const spendMonthStart = utcMonthStart(spendNow);
  const [spendRow] = (
    await getDb().execute<{
      prompt_tokens: string;
      completion_tokens: string;
      firm_tokens: string;
      platform_tokens: string;
    }>(sql`
      SELECT
        COALESCE(SUM(prompt_tokens), 0)::text AS prompt_tokens,
        COALESCE(SUM(completion_tokens), 0)::text AS completion_tokens,
        COALESCE(SUM(${sql.raw(LEDGER_TOKENS_SQL)})
          FILTER (WHERE firm_id IS NOT NULL), 0)::text AS firm_tokens,
        COALESCE(SUM(${sql.raw(LEDGER_TOKENS_SQL)})
          FILTER (WHERE firm_id IS NULL), 0)::text AS platform_tokens
      FROM clerk_inference_calls
      WHERE created_at >= ${spendMonthStart}
    `)
  ).rows;
  const spendPrompt = Number(spendRow?.prompt_tokens ?? 0);
  const spendCompletion = Number(spendRow?.completion_tokens ?? 0);
  const spendTotal = spendPrompt + spendCompletion;
  // budgetPace's own month-pace rule (monthPace — one body since round 54),
  // on the same UTC boundary.
  const { elapsed: monthElapsed, projected: projectedTokens } = monthPace(
    spendMonthStart,
    spendTotal,
    spendNow,
  );
  const spendUsd = usdEstimate(spendPrompt, spendCompletion);
  const projectedUsd =
    spendUsd !== null && monthElapsed > 0
      ? Number((spendUsd / monthElapsed).toFixed(4))
      : null;

  return {
    month: spendNow.toISOString().slice(0, 7),
    promptTokens: spendPrompt,
    completionTokens: spendCompletion,
    totalTokens: spendTotal,
    firmFundedTokens: Number(spendRow?.firm_tokens ?? 0),
    platformFundedTokens: Number(spendRow?.platform_tokens ?? 0),
    estimatedUsd: spendUsd,
    projectedTokens,
    projectedUsd,
  };
}
