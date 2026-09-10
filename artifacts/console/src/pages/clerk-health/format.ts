import { type ReactNode } from "react";
import type {
  AskFeedbackReportTotals,
  ClerkMetrics,
  ClerkMetricsCases,
  ClerkMetricsQualityAlert,
  EvalFixtureReport,
} from "@workspace/api-client-react";
import { errorStatus, serverErrorMessage } from "@/lib/errors";
import { formatPct, type BadgeTone } from "@/lib/format";

// Pure helpers, tone maps and the tab list for the Clerk health page (R110:
// split out of the 2,963-line page). No component renders here; the page's
// unit suite pins these through the index re-exports.

/** The shared metrics guard HealthPanel hands each metrics-driven tab:
 *  skeleton while /clerk/metrics loads, the query error on failure, the
 *  section markup once it resolves. */
export type MetricsGuard = (
  render: (metrics: ClerkMetrics) => ReactNode,
) => ReactNode;

export const HEALTH_WINDOWS = [7, 30, 90];

// The health page's many stacked sections, grouped for navigation. Grouping
// is presentation only — every section keeps its exact markup and testids —
// and the resistance/quality alert banners are hoisted ABOVE the tabs so a
// drop stays visible regardless of the active tab.
export const HEALTH_TABS = [
  { value: "overview", label: "Overview" },
  { value: "quality", label: "Quality" },
  { value: "economics", label: "Economics" },
  { value: "evals", label: "Evals" },
  { value: "canaries", label: "Canaries" },
] as const;

export const OUTCOME_TONE: Record<string, BadgeTone> = {
  ok: "emerald",
  invalid_discarded: "amber",
  error: "red",
};

// Evaluation fixtures: riskLabel is the fixture's NATURE (what it tests),
// outcome is what the model did with it. Injection fixtures are violet — an
// adversarial fixture is not a failure; a followed injection is (red pill in
// the detail row).
export const EVAL_RISK_TONE: Record<string, BadgeTone> = {
  clean: "slate",
  skewed: "amber",
  injection: "violet",
};

export const EVAL_OUTCOME_TONE: Record<string, BadgeTone> = {
  ok: "emerald",
  invalid: "amber",
  error: "red",
};

// Eval runs take seconds to minutes (each fixture is a live model call), so
// switch to seconds above 1 s instead of reusing the ms-latency formatter.
export function fmtEvalDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  return `${Math.round(ms)} ms`;
}

// Token counts get grouping separators so 1234567 reads as 1,234,567.
export function fmtTokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return Math.round(n).toLocaleString();
}

// Estimated spend is usually cents per window, so allow up to 4 decimals.
// null means the server has no per-token rates configured for the models used.
export function fmtUsd(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return "—";
  return usd.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

// The Cases tile packs the flow timings into its detail line: decision
// turnaround plus its claim-based split into queue-wait and active-review
// (the split appears only once cases have claim timestamps).
export function casesTileDetail(cases: ClerkMetricsCases): string | undefined {
  const parts: string[] = [];
  if (cases.avgDecisionMinutes != null) {
    parts.push(`avg decision ${Math.round(cases.avgDecisionMinutes)} min`);
  }
  if (cases.avgQueueWaitMinutes != null) {
    parts.push(`queue wait ${Math.round(cases.avgQueueWaitMinutes)}m`);
  }
  if (cases.avgActiveReviewMinutes != null) {
    parts.push(`active review ${Math.round(cases.avgActiveReviewMinutes)}m`);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

// Override-rate cells go red above 25% (extraction quality needs prompt
// attention) and amber above 10% (worth a watchful eye).
export function overrideRateClass(rate: number): string {
  if (rate > 0.25) return "text-red-600 dark:text-red-400 font-medium";
  if (rate > 0.1) return "text-amber-700 dark:text-amber-400 font-medium";
  return "";
}

// A correction-shape example renders as "extracted → final"; a missing side
// (the operator filled a blank, or blanked a hallucination) shows the same
// em-dash sentinel the eval mismatch rows use.
export function shapeExample(
  extracted: string | null,
  final: string | null,
): string {
  return `${extracted ?? "—"} → ${final ?? "—"}`;
}

// Model-canary fixture rows: a regressed row (the candidate read the fixture
// worse than the incumbent) gets the red treatment; everything else stays
// plain.
export function modelCanaryRowClass(regressed: boolean): string {
  return regressed ? "bg-red-50 dark:bg-red-950/40" : "";
}

// The quality-watch banner sentence: a month-over-month drop in the share of
// extracted fields operators KEPT at approval. Phrased exactly like the
// resistance banner (rate, month, rate, month, sample size) so the two
// alerts read as one family.
export function qualityAlertText(alert: ClerkMetricsQualityAlert): string {
  return (
    `Extraction kept-rate dropped from ${formatPct(alert.fromRate)} ` +
    `(${alert.fromMonth}) to ${formatPct(alert.toRate)} (${alert.toMonth}) ` +
    `over ${alert.fields} fields — review recent corrections.`
  );
}

// Intent-classification eval lane (round 15): the Ask classifier's own
// regression card — run the fixed question corpus, see accuracy and
// injection resistance per stored run. Deterministic scoring server-side.

export function retrievalRunLine(run: {
  hits: number;
  fixtureCount: number;
  k: number;
  mrr: number;
}): string {
  return `${run.hits}/${run.fixtureCount} recall@${run.k} · MRR ${run.mrr.toFixed(2)}`;
}

export function retrievalMissLine(run: {
  results: {
    key: string;
    expectedDoc: string;
    rank?: number | null;
    hit: boolean;
  }[];
}): string | null {
  const missed = run.results.filter((r) => !r.hit);
  if (missed.length === 0) return null;
  return `Missed: ${missed
    .map(
      (r) =>
        `${r.key} (wanted ${r.expectedDoc}${r.rank ? `, ranked ${r.rank}` : ""})`,
    )
    .join(", ")}`;
}

// Newest-first recall trend, capped at six runs — reads right-to-left like
// the runs list itself (newest on the left).
export function retrievalTrendLine(
  runs: { hits: number; fixtureCount: number }[],
): string | null {
  if (runs.length < 2) return null;
  return runs
    .slice(0, 6)
    .map((r) => `${r.hits}/${r.fixtureCount}`)
    .join(" ← ");
}

// Retrieval eval lane (rounds 47-48): the memory rail's regression card —
// embed the fixed labeled corpus with the LIVE embedding model and score
// recall@k / MRR deterministically in app code (no model judges anything,
// the real index is untouched). One platform-funded embedding call per
// run; the nightly sweep (clerk_auto_retrieval_eval) stores the same runs
// this card trends.

export function canaryPrefillNote(promptLoadFailed: boolean): string | null {
  return promptLoadFailed
    ? "Couldn't load the live prompt — paste a candidate manually."
    : null;
}

export const FIXTURE_SOURCE_TONE: Record<string, BadgeTone> = {
  static: "slate",
  grown: "blue",
  redteam: "violet",
};

// "redteam" is the wire value; the chip reads "red-team" like the prose.
export function fixtureSourceLabel(source: string): string {
  return source === "redteam" ? "red-team" : source;
}

// Accuracy from history: correct/compared across every stored run that
// scored this fixture. Null (rendered as the em-dash sentinel) until a run
// has compared at least one field — 0/0 is "no history", not 0%.
export function fixtureAccuracy(f: {
  fieldsCompared?: number;
  fieldsCorrect?: number;
}): number | null {
  if (!f.fieldsCompared) return null;
  return (f.fieldsCorrect ?? 0) / f.fieldsCompared;
}

// Why a static row has no retire button. Null for grown/red-team rows, which
// are curatable.
export function retireDisabledReason(source: string): string | null {
  return source === "static"
    ? "Static fixtures ship in code — removing one is a code change, not a curation act."
    : null;
}

// One-line inventory summary so the card reads at a glance even collapsed.
export function corpusSummary(report: EvalFixtureReport): string {
  let staticCount = 0;
  let grown = 0;
  let redteam = 0;
  let retired = 0;
  for (const f of report.fixtures) {
    if (f.source === "static") staticCount += 1;
    else if (f.source === "grown") grown += 1;
    else if (f.source === "redteam") redteam += 1;
    if (f.retired) retired += 1;
  }
  const parts = [
    `${report.fixtures.length} fixture(s) — ${staticCount} static, ${grown} grown, ${redteam} red-team`,
  ];
  if (retired > 0) parts.push(`${retired} retired`);
  parts.push(`history from ${report.runsScanned} stored run(s)`);
  return parts.join(" · ");
}

// Inline copy for a failed case promotion. The statuses are the contract's:
// 404 the case isn't there (or not visible), 409 it was already promoted,
// 400 the server refused the shape of the request — including SCRUB_REQUIRED
// when pseudonymization is unchecked for an active client, where the
// server's own words say exactly that and are relayed verbatim.
export function mintFixtureErrorCopy(err: unknown): string {
  const status = errorStatus(err);
  if (status === 404) return "No case with that id.";
  if (status === 409) {
    return "That case has already been promoted into the corpus.";
  }
  if (status === 400) {
    return (
      serverErrorMessage(err) ??
      "That case can't be promoted — check that it has been decided."
    );
  }
  return (
    serverErrorMessage(err) ??
    "Could not mint the fixture. Try again in a moment."
  );
}

// One line over the ask-feedback card: how the rated answers split, plus how
// many answers nobody rated (the denominator that keeps the split honest).
export function askFeedbackTotalsLine(totals: AskFeedbackReportTotals): string {
  return `${totals.helpful} helpful · ${totals.notHelpful} not helpful · ${totals.unrated} unrated`;
}

// The corpus can run to 200+ rows (red-team growth); render a preview and
// let the operator expand to everything.
export const CORPUS_PREVIEW_ROWS = 25;
export function visibleFixtureCount(total: number, showAll: boolean): number {
  return showAll ? total : Math.min(total, CORPUS_PREVIEW_ROWS);
}
