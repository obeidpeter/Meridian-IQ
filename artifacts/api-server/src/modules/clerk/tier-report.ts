import { sql } from "drizzle-orm";
import { getDb, runInBypassContext } from "@workspace/db";
import { CLERK_MODEL, modelForPurpose, parseModelTiers } from "./provider";

// Tier-suggestion report (round-9 idea #3). Round 7 shipped the per-purpose
// model-tier MECHANISM (CLERK_MODEL_TIERS); this ships the evidence for
// using it. Pure ledger SQL over a trailing window: per purpose — call
// volume, token spend and share, the validity taxonomy — joined with the
// tier map that is ACTUALLY in force, and folded through a deterministic
// recommendation rule. Zero model calls; the operator acts on the evidence
// by editing env config, and the prompt canary already exists to validate
// any switch before it ships.

export const TIER_REPORT_WINDOW_DAYS = 90;
// Below this many calls the validity rate is noise, not evidence.
export const TIER_MIN_CALLS = 50;
// A cheap tier must hold schema-valid output at effectively production
// quality; under this the recommendation is to keep (or revert to) the
// default model.
export const TIER_VALID_THRESHOLD = 0.99;

// Extraction is where corrections carry real money, and evals must measure
// what production extraction runs — never tier these on validity alone.
const STAKES_PURPOSES = new Set([
  "extract_invoice",
  "eval_extract",
  "eval_canary",
]);

export type TierRecommendation =
  | "candidate" // untiered, healthy, enough volume: try a cheaper model
  | "keep" // leave on the default model
  | "tiered" // already tiered and holding: leave as is
  | "revert" // tiered but validity slipped: go back to the default
  | "insufficient_data";

export interface TierReportRow {
  purpose: string;
  calls: number;
  totalTokens: number;
  spendShare: number;
  okCount: number;
  invalidCount: number;
  errorCount: number;
  killedCount: number;
  validRate: number;
  currentModel: string;
  tiered: boolean;
  recommendation: TierRecommendation;
  reason: string;
}

export interface TierReport {
  windowDays: number;
  totalTokens: number;
  baseModel: string;
  rows: TierReportRow[];
}

// The deterministic rule, exported for tests. killed calls are excluded from
// the validity denominator — the kill switch says nothing about the model.
export function tierRecommendation(input: {
  purpose: string;
  calls: number;
  validRate: number;
  tiered: boolean;
}): { recommendation: TierRecommendation; reason: string } {
  if (input.calls < TIER_MIN_CALLS) {
    return {
      recommendation: "insufficient_data",
      reason: `Fewer than ${TIER_MIN_CALLS} calls in the window — not enough evidence to judge.`,
    };
  }
  if (input.tiered) {
    return input.validRate >= TIER_VALID_THRESHOLD
      ? {
          recommendation: "tiered",
          reason: "Already on a tier and holding validity — leave as is.",
        }
      : {
          recommendation: "revert",
          reason:
            "The configured tier is not holding schema validity — consider reverting to the default model.",
        };
  }
  if (STAKES_PURPOSES.has(input.purpose)) {
    return {
      recommendation: "keep",
      reason:
        "Correction stakes: extraction (and the evals that measure it) stays on the default model.",
    };
  }
  return input.validRate >= TIER_VALID_THRESHOLD
    ? {
        recommendation: "candidate",
        reason:
          "High validity at volume — a cheaper tier is low-risk; validate with a prompt canary before switching.",
      }
    : {
        recommendation: "keep",
        reason: "Validity is below the tier threshold on the default model.",
      };
}

// The report. Ledger reads are bypass-only (migration 0005 posture — the
// gateway writes it outside tenant scope), same as the metrics module's
// callers: the route gates on clerk.use and operators run in bypass context
// anyway; the explicit wrapper keeps the module callable from tests.
export async function computeTierReport(): Promise<TierReport> {
  const rows = await runInBypassContext(async () => {
    return (
      await getDb().execute<{
        purpose: string;
        calls: number;
        total_tokens: number;
        ok_count: number;
        invalid_count: number;
        error_count: number;
        killed_count: number;
      }>(sql`
        SELECT purpose,
          COUNT(*)::int AS calls,
          COALESCE(SUM(COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0)), 0)::int
            AS total_tokens,
          COUNT(*) FILTER (WHERE outcome = 'ok')::int AS ok_count,
          COUNT(*) FILTER (WHERE outcome = 'invalid_discarded')::int AS invalid_count,
          COUNT(*) FILTER (WHERE outcome = 'error')::int AS error_count,
          COUNT(*) FILTER (WHERE outcome = 'killed')::int AS killed_count
        FROM clerk_inference_calls
        WHERE created_at >= now() - make_interval(days => ${TIER_REPORT_WINDOW_DAYS})
        GROUP BY purpose
        ORDER BY total_tokens DESC
      `)
    ).rows;
  });

  const tiers = parseModelTiers(process.env.CLERK_MODEL_TIERS);
  const totalTokens = rows.reduce((sum, r) => sum + Number(r.total_tokens), 0);

  return {
    windowDays: TIER_REPORT_WINDOW_DAYS,
    totalTokens,
    baseModel: CLERK_MODEL,
    rows: rows.map((r) => {
      const calls = Number(r.calls);
      const ok = Number(r.ok_count);
      const invalid = Number(r.invalid_count);
      const error = Number(r.error_count);
      const judged = ok + invalid + error;
      const validRate =
        judged === 0 ? 1 : Number((ok / judged).toFixed(4));
      const currentModel = modelForPurpose(r.purpose, tiers, CLERK_MODEL);
      const tiered = currentModel !== CLERK_MODEL;
      const rec = tierRecommendation({
        purpose: r.purpose,
        calls,
        validRate,
        tiered,
      });
      return {
        purpose: r.purpose,
        calls,
        totalTokens: Number(r.total_tokens),
        spendShare:
          totalTokens === 0
            ? 0
            : Number((Number(r.total_tokens) / totalTokens).toFixed(4)),
        okCount: ok,
        invalidCount: invalid,
        errorCount: error,
        killedCount: Number(r.killed_count),
        validRate,
        currentModel,
        tiered,
        recommendation: rec.recommendation,
        reason: rec.reason,
      };
    }),
  };
}
