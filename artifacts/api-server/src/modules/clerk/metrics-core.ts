import type { CorrectionShapeRow } from "./correction-shapes";

// Clerk operational metrics — the shape and the one rate rule (R126, split
// from metrics.ts so the query-group loaders and the façade share them
// without a cycle). Pure SQL aggregation over the case table and the
// append-only inference ledger — the numbers the monthly governance review
// needs (invalid-output rate, refusal rate, latency by model/prompt cohort,
// decision throughput), computed on demand. No model involvement, no new
// state.

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
  // Unit economics (idea #8): where the tokens actually go, and how the
  // failure taxonomy moves over time. Pure ledger SQL — the numbers pricing
  // decisions and a provider evaluation will want.
  economics: {
    byPurpose: {
      purpose: string;
      calls: number;
      promptTokens: number;
      completionTokens: number;
      errorCount: number;
      estimatedUsd: number | null;
    }[];
    months: {
      month: string; // "YYYY-MM" (UTC — the budget month boundary)
      calls: number;
      promptTokens: number;
      completionTokens: number;
      okCount: number;
      invalidCount: number;
      killedCount: number;
      errorCount: number;
    }[];
  };
  corrections: {
    field: string;
    total: number;
    overridden: number;
    overrideRate: number;
  }[];
  // Correction-shape mining: the same corrections exhaust classified by the
  // SHAPE of each override — day/month flips, percent-vs-fraction VAT, powers
  // of ten, missed and hallucinated values — deterministic string/number
  // analysis over the calibration sample, zero model calls. The override-rate
  // table says WHERE Clerk is wrong; this says HOW, which is what a prompt or
  // parser fix needs. Absent when the window holds no changed corrections.
  correctionShapes?: CorrectionShapeRow[];
  // Per-supplier accuracy (exhaust idea #9): the corrections exhaust joined to
  // the approved invoice's supplier identity — which suppliers' documents
  // Clerk reads worst. The list a firm uses to nudge clients toward cleaner
  // invoices, and the evidence for where supplier-memory exemplars earn their
  // keep. Pure SQL, zero model calls.
  supplierAccuracy: {
    supplierName: string;
    firmName: string | null;
    cases: number;
    fieldsCompared: number;
    overridden: number;
    overrideRate: number;
  }[];
  ask: {
    total: number;
    answered: number;
    refused: number;
    refusalRate: number;
  };
  // Platform spend meter (round-7 idea #3): the whole platform's
  // month-to-date token consumption from the ledger — budget pace is
  // per-firm; this is the number the provider invoice arrives against.
  // Pure ledger SQL; the projection is the same linear month-pace rule as
  // budgetPace (UTC month, matching the budget boundary).
  platformSpend: {
    month: string; // "YYYY-MM" (UTC)
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    firmFundedTokens: number;
    platformFundedTokens: number;
    estimatedUsd: number | null;
    projectedTokens: number;
    projectedUsd: number | null;
  };
  // Injection-resistance trend (round-6 idea #8): resistance over time from
  // the stored eval runs — pure SQL over clerk_eval_runs, zero model calls.
  // Monthly buckets show drift; the per-prompt-version split shows whether a
  // promoted prompt actually held the line the canary predicted.
  injectionTrend: {
    months: {
      month: string; // "YYYY-MM" (UTC)
      runs: number;
      injectionFixtures: number;
      injectionResisted: number;
      resistanceRate: number;
    }[];
    byPromptVersion: {
      promptVersion: string;
      runs: number;
      injectionFixtures: number;
      injectionResisted: number;
      resistanceRate: number;
    }[];
  };
  // Number-grounding violations (round-17 idea #1): phrasing surfaces whose
  // model output carried a numeral the facts never stated — each such output
  // was replaced by its deterministic template and left one pointer-only
  // audit event (grounding.ts). Zero is the healthy reading.
  grounding: {
    violations: number;
    bySurface: { surface: string; count: number }[];
  };
  // Narration-match lane health (narration-match.ts narrationKeptRate — one
  // source, so this block and any alerting can never disagree): suggestions
  // in the window split pick vs abstention, and — of the picks whose line a
  // human has since decided by ACCEPTING a proposal — kept (accepted the
  // suggested proposal) vs overridden (accepted a different one). Pure SQL
  // over the suggestion jsonb and the proposal decisions; nothing stored.
  narrationMatch: {
    suggested: number;
    kept: number;
    overridden: number;
    abstained: number;
  };
  // Resistance-drop alert (round-8 idea #2): present when the newest measured
  // month's injection resistance fell materially below the previous one —
  // same pure rule as the sweep that writes the audit alert
  // (modules/clerk/resistance-watch.ts), so banner and alert always agree.
  resistanceAlert?: {
    fromMonth: string;
    toMonth: string;
    fromRate: number;
    toRate: number;
    injectionFixtures: number;
  };
  // Kept-rate drift: monthly kept-rate buckets from the corrections exhaust
  // (fields the operator left unchanged / fields compared) — the accuracy
  // sibling of the injection trend. Shared with the quality-watch sweep
  // (modules/clerk/quality-watch.ts) so chart and alert read one source.
  // Absent when the exhaust holds no measured months.
  keptRateTrend?: {
    month: string; // "YYYY-MM" (UTC)
    fields: number;
    keptRate: number;
  }[];
  // Present when the newest measured month's kept-rate fell materially below
  // the previous one — the same pure rule as the sweep that writes the audit
  // alert, so banner and alert always agree.
  qualityAlert?: {
    fromMonth: string;
    toMonth: string;
    fromRate: number;
    toRate: number;
    fields: number;
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

export function rate(part: number, whole: number): number {
  return whole === 0 ? 0 : Number((part / whole).toFixed(4));
}
