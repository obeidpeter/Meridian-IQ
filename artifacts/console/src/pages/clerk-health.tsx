import { useState } from "react";
import {
  useGetClerkMetrics,
  useRunClerkEval,
  useListClerkEvalRuns,
  getGetClerkMetricsQueryKey,
  getListClerkEvalRunsQueryKey,
} from "@workspace/api-client-react";
import type { ClerkMetricsCases } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { QueryError } from "@/components/query-error";
import { StatTile } from "@/components/stat-tile";
import { useToast } from "@/hooks/use-toast";
import { serverErrorMessage } from "@/lib/errors";
import {
  formatDateTime,
  formatPct,
  pillClasses,
  type BadgeTone,
} from "@/lib/format";
import { STATUS_TONE } from "@/pages/clerk-shared";

// ---- Health tab -----------------------------------------------------------
// Read-only operational metrics for the Clerk: case flow, ask refusals and
// inference quality per model+prompt cohort. Numbers come straight from
// /clerk/metrics; the window selector re-queries the server.

const HEALTH_WINDOWS = [7, 30, 90];

const OUTCOME_TONE: Record<string, BadgeTone> = {
  ok: "emerald",
  invalid_discarded: "amber",
  error: "red",
};

// Evaluation fixtures: riskLabel is the fixture's NATURE (what it tests),
// outcome is what the model did with it. Injection fixtures are violet — an
// adversarial fixture is not a failure; a followed injection is (red pill in
// the detail row).
const EVAL_RISK_TONE: Record<string, BadgeTone> = {
  clean: "slate",
  skewed: "amber",
  injection: "violet",
};

const EVAL_OUTCOME_TONE: Record<string, BadgeTone> = {
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

function BreakdownRow({
  title,
  entries,
  tones,
  testId,
}: {
  title: string;
  entries: Record<string, number>;
  tones: Record<string, BadgeTone>;
  testId: string;
}) {
  const items = Object.entries(entries).sort((a, b) => b[1] - a[1]);
  return (
    <div data-testid={testId}>
      <p className="text-xs font-medium text-muted-foreground uppercase mb-2">
        {title}
      </p>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing in this window.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {items.map(([key, count]) => (
            <span key={key} className={pillClasses(tones[key] ?? "slate")}>
              {key.replace(/_/g, " ")}
              <span className="tabular-nums font-semibold">{count}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function HealthPanel() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [windowDays, setWindowDays] = useState(30);
  const params = { windowDays };
  const {
    data: metrics,
    isLoading,
    error,
    refetch,
  } = useGetClerkMetrics(params, {
    query: { queryKey: getGetClerkMetricsQueryKey(params) },
  });

  // Evaluation runs: the synthetic fixture corpus scored against the live
  // model. Running one is a deliberate act (it spends real model calls), so
  // it sits behind a button rather than loading eagerly like the metrics.
  const evalParams = { limit: 20 };
  const {
    data: evalRuns,
    isLoading: evalRunsLoading,
    error: evalRunsError,
    refetch: refetchEvalRuns,
  } = useListClerkEvalRuns(evalParams, {
    query: { queryKey: getListClerkEvalRunsQueryKey(evalParams) },
  });

  const runEval = useRunClerkEval({
    mutation: {
      onSuccess: (run) => {
        queryClient.invalidateQueries({
          queryKey: getListClerkEvalRunsQueryKey(evalParams),
        });
        toast({
          title: "Evaluation complete",
          description: `Field accuracy ${formatPct(run.accuracy)} · injection resisted ${run.injectionResisted}/${run.injectionFixtures} across ${run.fixtureCount} fixtures.`,
        });
      },
      onError: (e) => {
        toast({
          title: "Evaluation failed",
          description:
            serverErrorMessage(e) ?? "Could not run the evaluation.",
          variant: "destructive",
        });
      },
    },
  });

  // Fixture-level detail for the most recent run, behind a toggle like the
  // capture form's open/close.
  const [showEvalDetail, setShowEvalDetail] = useState(false);
  const latestRun = evalRuns?.[0];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-sm text-muted-foreground">
          How the Clerk is behaving — case flow, refusals and inference
          quality.
        </p>
        <div className="w-36">
          <Select
            value={String(windowDays)}
            onValueChange={(v) => setWindowDays(Number(v))}
          >
            <SelectTrigger
              aria-label="Metrics window"
              data-testid="select-health-window"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {HEALTH_WINDOWS.map((d) => (
                <SelectItem key={d} value={String(d)}>
                  Last {d} days
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : error || !metrics ? (
        <QueryError
          thing="Clerk health metrics"
          onRetry={() => refetch()}
          // The fetch error message carries the HTTP status ("HTTP 404 …"),
          // which instantly separates a stale api-server build (404 — rebuild
          // and restart the server) from a server fault (500).
          detail={error instanceof Error ? error.message : undefined}
        />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label="Cases"
              value={String(metrics.cases.total)}
              detail={casesTileDetail(metrics.cases)}
              testId="stat-cases-total"
            />
            <StatTile
              label="Ask refusal rate"
              value={formatPct(metrics.ask.refusalRate)}
              detail={`${metrics.ask.refused} of ${metrics.ask.total} questions refused`}
              testId="stat-refusal-rate"
            />
            <StatTile
              label="Invalid inference rate"
              value={formatPct(metrics.inference.invalidRate)}
              detail={`error rate ${formatPct(metrics.inference.errorRate)} of ${metrics.inference.total} calls`}
              testId="stat-invalid-rate"
            />
            <StatTile
              label="Latency p95"
              value={fmtMs(metrics.inference.latencyP95Ms)}
              detail={`p50 ${fmtMs(metrics.inference.latencyP50Ms)}`}
              testId="stat-latency-p95"
            />
          </div>

          <div data-testid="section-cost">
            <p className="text-xs font-medium text-muted-foreground uppercase mb-2">
              Cost
            </p>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              <StatTile
                label="Prompt tokens"
                value={fmtTokens(metrics.cost.promptTokens)}
                testId="stat-cost-prompt-tokens"
              />
              <StatTile
                label="Completion tokens"
                value={fmtTokens(metrics.cost.completionTokens)}
                testId="stat-cost-completion-tokens"
              />
              <StatTile
                label="Calls with usage"
                value={fmtTokens(metrics.cost.callsWithUsage)}
                testId="stat-cost-calls-with-usage"
              />
              <StatTile
                label="Tokens / decided case"
                value={fmtTokens(metrics.cost.tokensPerDecidedCase)}
                testId="stat-cost-tokens-per-case"
              />
              <StatTile
                label="Estimated spend"
                value={fmtUsd(metrics.cost.estimatedUsd)}
                detail={
                  metrics.cost.estimatedUsd == null
                    ? "rates not configured"
                    : undefined
                }
                testId="stat-cost-estimated-usd"
              />
            </div>
          </div>

          <Card>
            <CardContent className="pt-6 space-y-4">
              <BreakdownRow
                title="Cases by status"
                entries={metrics.cases.byStatus}
                tones={STATUS_TONE}
                testId="breakdown-by-status"
              />
              <BreakdownRow
                title="Inference by outcome"
                entries={metrics.inference.byOutcome}
                tones={OUTCOME_TONE}
                testId="breakdown-by-outcome"
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Inference cohorts (model × prompt)
              </CardTitle>
            </CardHeader>
            <CardContent>
              {metrics.inference.cohorts.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No inference calls in this window.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                        <th className="py-2 pr-3 font-medium">Model</th>
                        <th className="py-2 pr-3 font-medium">Prompt</th>
                        <th className="py-2 pr-3 font-medium">Purpose</th>
                        <th className="py-2 pr-3 font-medium text-right">
                          Total
                        </th>
                        <th className="py-2 pr-3 font-medium text-right">OK</th>
                        <th className="py-2 font-medium text-right">p95</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {metrics.inference.cohorts.map((c) => (
                        <tr
                          key={`${c.model}-${c.promptVersion}-${c.purpose}`}
                          data-testid={`row-cohort-${c.model}-${c.promptVersion}-${c.purpose}`}
                        >
                          <td className="py-2 pr-3">
                            <code className="text-xs">{c.model}</code>
                          </td>
                          <td className="py-2 pr-3">
                            <code className="text-xs">{c.promptVersion}</code>
                          </td>
                          <td className="py-2 pr-3">{c.purpose}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {c.total}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {c.okCount}
                          </td>
                          <td className="py-2 text-right tabular-nums">
                            {fmtMs(c.latencyP95Ms)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Field corrections</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">
                How often operators corrected each extracted field before
                approval — the extraction-quality signal (labeled outcomes).
              </p>
              {metrics.corrections.length === 0 ? (
                <p
                  className="text-sm text-muted-foreground"
                  data-testid="text-corrections-empty"
                >
                  No corrections yet — they appear once cases are approved.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table
                    className="w-full text-sm"
                    data-testid="table-corrections"
                  >
                    <thead>
                      <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                        <th className="py-2 pr-3 font-medium">Field</th>
                        <th className="py-2 pr-3 font-medium text-right">
                          Total
                        </th>
                        <th className="py-2 pr-3 font-medium text-right">
                          Overridden
                        </th>
                        <th className="py-2 font-medium text-right">
                          Override rate
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {metrics.corrections.map((c) => (
                        <tr
                          key={c.field}
                          data-testid={`row-correction-${c.field}`}
                        >
                          <td className="py-2 pr-3">
                            <code className="text-xs">{c.field}</code>
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {c.total}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {c.overridden}
                          </td>
                          <td
                            className={`py-2 text-right tabular-nums ${overrideRateClass(c.overrideRate)}`}
                          >
                            {formatPct(c.overrideRate)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      <Card data-testid="section-evaluation">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Evaluation</CardTitle>
          <Button
            size="sm"
            onClick={() => runEval.mutate()}
            disabled={runEval.isPending}
            data-testid="button-run-eval"
          >
            {runEval.isPending ? "Running…" : "Run evaluation"}
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Runs the synthetic fixture corpus through the live model (about 6
            model calls, one per fixture — it can take tens of seconds) and
            scores field accuracy and prompt-injection resistance.
          </p>
          {evalRunsLoading ? (
            <Skeleton className="h-24" />
          ) : evalRunsError ? (
            <QueryError
              thing="evaluation runs"
              onRetry={() => refetchEvalRuns()}
              detail={serverErrorMessage(evalRunsError)}
            />
          ) : !evalRuns || evalRuns.length === 0 ? (
            <p
              className="text-sm text-muted-foreground"
              data-testid="text-eval-empty"
            >
              No evaluation runs yet — run one to baseline the current model
              and prompt.
            </p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="table-eval-runs">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                      <th className="py-2 pr-3 font-medium">When</th>
                      <th className="py-2 pr-3 font-medium">Model</th>
                      <th className="py-2 pr-3 font-medium">Prompt</th>
                      <th className="py-2 pr-3 font-medium text-right">
                        Field accuracy
                      </th>
                      <th className="py-2 pr-3 font-medium text-right">
                        Injection
                      </th>
                      <th className="py-2 pr-3 font-medium text-right">
                        Fixtures
                      </th>
                      <th className="py-2 font-medium text-right">Duration</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {evalRuns.map((r) => (
                      <tr key={r.id} data-testid={`row-eval-run-${r.id}`}>
                        <td className="py-2 pr-3 whitespace-nowrap">
                          {formatDateTime(r.createdAt)}
                        </td>
                        <td className="py-2 pr-3">
                          <code className="text-xs">{r.model}</code>
                        </td>
                        <td className="py-2 pr-3">
                          <code className="text-xs">{r.promptVersion}</code>
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {formatPct(r.accuracy)}
                        </td>
                        <td
                          className={`py-2 pr-3 text-right tabular-nums ${
                            r.injectionResisted < r.injectionFixtures
                              ? "text-red-600 dark:text-red-400 font-medium"
                              : ""
                          }`}
                        >
                          {r.injectionResisted}/{r.injectionFixtures}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {r.fixtureCount}
                        </td>
                        <td className="py-2 text-right tabular-nums">
                          {fmtEvalDuration(r.durationMs)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {latestRun && (
                <div className="space-y-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setShowEvalDetail((o) => !o)}
                    data-testid="button-toggle-eval-detail"
                  >
                    {showEvalDetail
                      ? "Hide fixture detail"
                      : "Show fixture detail"}
                  </Button>
                  {showEvalDetail && (
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-muted-foreground uppercase">
                        Fixtures — most recent run
                      </p>
                      <div
                        className="border rounded-md divide-y text-sm"
                        data-testid="detail-eval-fixtures"
                      >
                        {latestRun.results.map((fx) => (
                          <div
                            key={fx.key}
                            className="px-3 py-2 space-y-1"
                            data-testid={`row-eval-fixture-${fx.key}`}
                          >
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="flex-1 min-w-0 truncate font-medium">
                                {fx.label}
                              </span>
                              <span
                                className={pillClasses(
                                  EVAL_RISK_TONE[fx.riskLabel] ?? "slate",
                                )}
                              >
                                {fx.riskLabel}
                              </span>
                              <span
                                className={pillClasses(
                                  EVAL_OUTCOME_TONE[fx.outcome] ?? "slate",
                                )}
                              >
                                {fx.outcome}
                              </span>
                              <span className="text-xs text-muted-foreground tabular-nums">
                                {fx.fieldsCorrect}/{fx.fieldsCompared} fields
                              </span>
                              {fx.injectionResisted === false && (
                                <span className={pillClasses("red")}>
                                  injection followed
                                </span>
                              )}
                            </div>
                            {fx.mismatches.length > 0 && (
                              <ul className="text-xs text-muted-foreground space-y-0.5">
                                {fx.mismatches.map((m) => (
                                  <li key={m.field}>
                                    <code>{m.field}</code>: {m.expected ?? "—"}{" "}
                                    → {m.actual ?? "—"}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
