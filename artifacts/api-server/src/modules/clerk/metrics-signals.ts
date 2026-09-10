import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@workspace/db";
import {
  detectResistanceDrop,
  injectionResistanceMonths,
} from "./resistance-watch";
import { detectQualityDrop, keptRateMonths } from "./quality-watch";
import { GROUNDING_VIOLATION_ACTION } from "./grounding";
import { narrationKeptRate } from "./narration-match";
import { rate, type ClerkMetrics } from "./metrics-core";

// Clerk metrics — the quality signals (R126, split from metrics.ts): the
// injection-resistance trend and its drop alert, grounding violations, the
// narration-match lane and the kept-rate drift with its alert. Each block
// reads the SAME source its sweep reads (resistance-watch, quality-watch,
// narration-match), so chart and alert can never disagree. Awaited in the
// original order.

export async function loadQualitySignals(
  since: SQL,
  windowDays: number,
): Promise<{
  injectionTrend: ClerkMetrics["injectionTrend"];
  grounding: ClerkMetrics["grounding"];
  narrationMatch: ClerkMetrics["narrationMatch"];
  resistanceAlert: ReturnType<typeof detectResistanceDrop>;
  keptRateTrend: Awaited<ReturnType<typeof keptRateMonths>>;
  qualityAlert: ReturnType<typeof detectQualityDrop>;
}> {
  const db = getDb();
  // Trailing six months of eval runs (shared with the resistance-drop sweep
  // so the alert and the chart read the same buckets), plus the all-time
  // per-prompt-version split — runs with no injection fixtures are excluded
  // from the rate.
  const trendMonths = await injectionResistanceMonths();
  // Same rule as the sweep's alert — the banner and the audit event agree.
  const resistanceAlert = detectResistanceDrop(trendMonths);
  // Grounding violations in the window, by surface — counted straight from
  // the pointer-only audit events grounding.ts writes (the action-prefixed
  // audit index carries the probe).
  const groundingRows = (
    await db.execute(sql`
      SELECT entity_id AS surface, COUNT(*)::int AS count
      FROM audit_events
      WHERE action = ${GROUNDING_VIOLATION_ACTION}
        AND created_at >= ${since}
      GROUP BY 1
      ORDER BY 2 DESC, 1
    `)
  ).rows as { surface: string; count: number }[];
  const grounding = {
    violations: groundingRows.reduce((sum, r) => sum + Number(r.count), 0),
    bySurface: groundingRows.map((r) => ({
      surface: r.surface,
      count: Number(r.count),
    })),
  };
  // Narration-match kept-rate: the same window as the headline metrics, read
  // from the lane's own SQL (narration-match.ts) so console and module agree.
  const narrationRate = await narrationKeptRate(windowDays);
  const narrationMatch = {
    suggested: narrationRate.suggested,
    kept: narrationRate.kept,
    overridden: narrationRate.overridden,
    abstained: narrationRate.abstained,
  };
  // Kept-rate drift buckets, shared with the quality-watch sweep exactly as
  // the injection trend is shared with the resistance watch — one source, so
  // the chart and the alert can never disagree.
  const keptRateTrend = await keptRateMonths();
  const qualityAlert = detectQualityDrop(keptRateTrend);
  const trendPromptRows = (
    await db.execute(sql`
      SELECT prompt_version,
        COUNT(*)::int AS runs,
        SUM(injection_fixtures)::int AS injection_fixtures,
        SUM(injection_resisted)::int AS injection_resisted
      FROM clerk_eval_runs
      GROUP BY 1
      ORDER BY MAX(created_at) DESC
      LIMIT 10
    `)
  ).rows as {
    prompt_version: string;
    runs: number;
    injection_fixtures: number;
    injection_resisted: number;
  }[];

  return {
    injectionTrend: {
      months: trendMonths.map((m) => ({
        month: m.month,
        runs: m.runs,
        injectionFixtures: m.injectionFixtures,
        injectionResisted: m.injectionResisted,
        resistanceRate: rate(m.injectionResisted, m.injectionFixtures),
      })),
      byPromptVersion: trendPromptRows.map((p) => ({
        promptVersion: p.prompt_version,
        runs: Number(p.runs),
        injectionFixtures: Number(p.injection_fixtures),
        injectionResisted: Number(p.injection_resisted),
        resistanceRate: rate(
          Number(p.injection_resisted),
          Number(p.injection_fixtures),
        ),
      })),
    },
    grounding,
    narrationMatch,
    resistanceAlert,
    keptRateTrend,
    qualityAlert,
  };
}
