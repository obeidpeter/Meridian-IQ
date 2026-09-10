import { sql } from "drizzle-orm";
import { computeCorrectionShapes } from "./correction-shapes";
import {
  getDb,
  type ClerkCorrection,
  type ClerkExtraction,
} from "@workspace/db";
import { rate, type ClerkMetrics } from "./metrics-core";
import {
  loadAskOutcomes,
  loadCaseMetrics,
  loadCorrectionRates,
  loadSupplierAccuracy,
} from "./metrics-cases";
import {
  loadCostTotals,
  loadEconomics,
  loadInferenceMetrics,
  loadPlatformSpend,
  makeUsdEstimator,
} from "./metrics-inference";
import { loadQualitySignals } from "./metrics-signals";

// Clerk operational metrics (CLK-OBS-04, CLK-OPS-06/07). Pure SQL aggregation
// over the case table and the append-only inference ledger — the numbers the
// monthly governance review needs (invalid-output rate, refusal rate, latency
// by model/prompt cohort, decision throughput), computed on demand. No model
// involvement, no new state.
//
// R126: getClerkMetrics is the façade over the query groups — metrics-cases
// (clerk_cases), metrics-inference (the ledger and the ONE pricing rule),
// metrics-signals (the shared-source quality blocks) — with the ClerkMetrics
// shape in metrics-core. Calibration stays here: it is shared with the
// adaptive fast lane below.

export type { ClerkMetrics } from "./metrics-core";

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

// The calibration sample: recent approved extractions with a corrections
// diff, newest CALIBRATION_SAMPLE_LIMIT so the folds stay cheap as history
// grows. The ONE spelling of the query BOTH consumers read — getClerkMetrics'
// console calibration table (platform-wide) and firmFastLaneThreshold
// (narrowed to one firm's exhaust) — so the fast-lane evidence and the
// calibration table can never read different predicates. The window is a
// parameter: getClerkMetrics passes the caller's windowDays, the fast lane
// pins FAST_LANE_WINDOW_DAYS.
const CALIBRATION_SAMPLE_LIMIT = 500;

async function calibrationSample(
  windowDays: number,
  firmId?: string,
): Promise<
  {
    extraction: ClerkExtraction | null;
    corrections: ClerkCorrection[] | null;
  }[]
> {
  return (
    await getDb().execute(sql`
      SELECT extraction, corrections
      FROM clerk_cases
      WHERE created_at >= now() - make_interval(days => ${windowDays})
        ${firmId ? sql`AND firm_id = ${firmId}` : sql``}
        AND kind = 'extraction'
        AND status = 'approved'
        AND extraction IS NOT NULL
        AND corrections IS NOT NULL
      ORDER BY created_at DESC
      LIMIT ${CALIBRATION_SAMPLE_LIMIT}
    `)
  ).rows as {
    extraction: ClerkExtraction | null;
    corrections: ClerkCorrection[] | null;
  }[];
}

// The loaders are awaited SEQUENTIALLY in the original query order (no
// Promise.all), so connection use and the RLS posture are unchanged; the
// pricing env rates are read per call, at the same point in the sequence
// as before (after the per-case query, before supplier accuracy).
export async function getClerkMetrics(windowDays = 30): Promise<ClerkMetrics> {
  const since = sql`now() - make_interval(days => ${windowDays})`;

  const cases = await loadCaseMetrics(since);
  const corrections = await loadCorrectionRates(since);
  const inference = await loadInferenceMetrics(since);
  const costTotals = await loadCostTotals(since);
  const usdEstimate = makeUsdEstimator();
  const supplierAccuracy = await loadSupplierAccuracy(since);
  const economics = await loadEconomics(since, usdEstimate);
  const ask = await loadAskOutcomes(since);

  // Calibration input: the shared bounded sample (calibrationSample above),
  // platform-wide over the caller's window.
  const calibrationRows = await calibrationSample(windowDays);
  const calibration = computeCalibration(calibrationRows);
  // Shape mining reads the SAME sample as calibration — one bounded query,
  // two deterministic folds over the corrections exhaust.
  const correctionShapes = computeCorrectionShapes(calibrationRows);

  const platformSpend = await loadPlatformSpend(usdEstimate);
  const signals = await loadQualitySignals(since, windowDays);

  return {
    windowDays,
    cases,
    inference,
    cost: {
      ...costTotals,
      estimatedUsd: usdEstimate(
        costTotals.promptTokens,
        costTotals.completionTokens,
      ),
    },
    economics,
    corrections,
    supplierAccuracy,
    ask,
    platformSpend,
    injectionTrend: signals.injectionTrend,
    grounding: signals.grounding,
    narrationMatch: signals.narrationMatch,
    ...(signals.resistanceAlert
      ? { resistanceAlert: signals.resistanceAlert }
      : {}),
    ...(signals.keptRateTrend.length > 0
      ? { keptRateTrend: signals.keptRateTrend }
      : {}),
    ...(signals.qualityAlert ? { qualityAlert: signals.qualityAlert } : {}),
    ...(calibration ? { calibration } : {}),
    ...(correctionShapes.length > 0 ? { correctionShapes } : {}),
  };
}

// ---- Adaptive fast lane (round 7) ------------------------------------------
// Per-firm fast-lane confidence threshold, derived from the firm's OWN
// calibration exhaust. Callers thread the returned value into the fast-lane
// predicate (bulk-approve.ts fastLaneBlocker; the console reads the same
// number off kase.fastLaneThreshold) so the queue and the bulk-approve
// re-verify can never disagree.
//
// The rule — the deliberate CONSERVATIVE first step, not a general model:
// only when the firm's top confidence band ("0.8-1.0") holds a real sample
// (>= FAST_LANE_MIN_FIELDS compared header fields in the window) AND the
// operators kept >= FAST_LANE_MIN_KEPT_RATE of those values unchanged does
// the threshold relax from the default 0.9 to the floor 0.8. Two outcomes
// only, floored at 0.8 — no interpolation, no per-field tuning — because the
// fast lane bulk-approves critical fields and a miscalibrated relaxation is
// operator trust spent at compliance cost. Everything is recomputed from SQL
// on demand; nothing is stored.

export const FAST_LANE_DEFAULT = 0.9;
export const FAST_LANE_FLOOR = 0.8;

// The calibration band the rule reads (CALIBRATION_BANDS' top band).
const FAST_LANE_BAND = "0.8-1.0";
const FAST_LANE_MIN_FIELDS = 200;
const FAST_LANE_MIN_KEPT_RATE = 0.97;
// Same window as getClerkMetrics' default calibration input; the query
// itself (predicates and sample cap) is calibrationSample, shared with the
// console's calibration table, so the two read the same evidence shape by
// construction.
const FAST_LANE_WINDOW_DAYS = 30;

export async function firmFastLaneThreshold(
  firmId: string | null,
): Promise<number> {
  // Operator captures carry no firm — no exhaust to justify relaxing.
  if (!firmId) return FAST_LANE_DEFAULT;
  // The SHARED calibration sample (calibrationSample) narrowed to ONE firm's
  // approved, corrected extractions. clerk_cases is bypass-only RLS: callers
  // run under an operator/bypass context (bulk-approve's per-item bypass
  // transaction, the operator-facing case reads).
  const rows = await calibrationSample(FAST_LANE_WINDOW_DAYS, firmId);
  const calibration = computeCalibration(rows);
  const band = calibration?.buckets.find((b) => b.range === FAST_LANE_BAND);
  if (
    band &&
    band.fields >= FAST_LANE_MIN_FIELDS &&
    band.keptRate >= FAST_LANE_MIN_KEPT_RATE
  ) {
    return FAST_LANE_FLOOR;
  }
  return FAST_LANE_DEFAULT;
}
