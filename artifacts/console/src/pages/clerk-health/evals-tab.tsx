import { useState } from "react";
import {
  useRunClerkEval,
  useListClerkEvalRuns,
  getListClerkEvalRunsQueryKey,
} from "@workspace/api-client-react";
import type { ClerkMetrics } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/query-error";
import { ScrollRegion } from "@/components/scroll-region";
import { useToast } from "@/hooks/use-toast";
import { serverErrorMessage } from "@/lib/errors";
import { formatDateTime, formatPct, pillClasses } from "@/lib/format";
import { EVAL_RISK_TONE, EVAL_OUTCOME_TONE, fmtEvalDuration } from "./format";
import {
  DigestImpactCard,
  IntentEvalCard,
  PhrasingEvalCard,
  RetrievalEvalCard,
} from "./eval-cards";
import { EvalCorpusCard } from "./corpus-card";

// The Evals tab of the Clerk health page (R110: split out of the page): the
// eval cards, the evaluation-run card with its query and mutation, the
// corpus card, number grounding and the injection trend.

export function EvalsTab({ metrics }: { metrics: ClerkMetrics | undefined }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
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
          description: serverErrorMessage(e) ?? "Could not run the evaluation.",
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
    <>
      <IntentEvalCard />

      <PhrasingEvalCard />
      <RetrievalEvalCard />

      <DigestImpactCard />

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
              No evaluation runs yet — run one to baseline the current model and
              prompt.
            </p>
          ) : (
            <>
              <ScrollRegion label="Evaluation runs table">
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
              </ScrollRegion>
              {latestRun && (
                <div className="space-y-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setShowEvalDetail((o) => !o)}
                    aria-expanded={showEvalDetail}
                    aria-controls="detail-eval-fixtures"
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
                        id="detail-eval-fixtures"
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

      <EvalCorpusCard />

      {metrics && (
        <Card data-testid="section-number-grounding">
          <CardHeader>
            <CardTitle className="text-base">Number grounding</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Every phrased surface (digest, statements, chasers, replies, cover
              notes, advisory briefs) is checked against its own facts: a
              numeral the facts never stated forfeits the phrasing and the
              deterministic template answers instead. Zero is the healthy
              reading.
            </p>
            <p className="text-sm" data-testid="text-grounding-violations">
              {metrics.grounding.violations === 0
                ? `No violations in the last ${metrics.windowDays} days — every phrased number was grounded.`
                : `${metrics.grounding.violations} violation(s) in the last ${metrics.windowDays} days — each answered with the template instead.`}
            </p>
            {metrics.grounding.bySurface.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {metrics.grounding.bySurface.map((s) => (
                  <span key={s.surface} className={pillClasses("amber")}>
                    {s.surface.replace(/_/g, " ")}
                    <span className="tabular-nums font-semibold">
                      {s.count}
                    </span>
                  </span>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {metrics && metrics.injectionTrend.months.length > 0 && (
        <Card data-testid="section-injection-trend">
          <CardHeader>
            <CardTitle className="text-base">
              Injection resistance trend
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              From the stored evaluation runs (including red-team fixtures) —
              resistance is the share of injection fixtures where every critical
              field kept its legitimate value. Pure SQL, no model involved in
              the judgment.
            </p>
            <div className="grid gap-4 md:grid-cols-2">
              <ScrollRegion label="Injection resistance by month table">
                <table
                  className="w-full text-sm"
                  data-testid="table-injection-months"
                >
                  <thead>
                    <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                      <th className="py-2 pr-3 font-medium">Month</th>
                      <th className="py-2 pr-3 font-medium text-right">Runs</th>
                      <th className="py-2 font-medium text-right">Resisted</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {metrics.injectionTrend.months.map((m) => (
                      <tr key={m.month}>
                        <td className="py-2 pr-3 tabular-nums">{m.month}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {m.runs}
                        </td>
                        <td className="py-2 text-right tabular-nums">
                          {m.injectionFixtures === 0
                            ? "—"
                            : `${m.injectionResisted}/${m.injectionFixtures} (${formatPct(m.resistanceRate)})`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollRegion>
              <ScrollRegion label="Injection prompts table">
                <table
                  className="w-full text-sm"
                  data-testid="table-injection-prompts"
                >
                  <thead>
                    <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                      <th className="py-2 pr-3 font-medium">Prompt</th>
                      <th className="py-2 pr-3 font-medium text-right">Runs</th>
                      <th className="py-2 font-medium text-right">Resisted</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {metrics.injectionTrend.byPromptVersion.map((p) => (
                      <tr key={p.promptVersion}>
                        <td className="py-2 pr-3 font-mono text-xs">
                          {p.promptVersion}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {p.runs}
                        </td>
                        <td className="py-2 text-right tabular-nums">
                          {p.injectionFixtures === 0
                            ? "—"
                            : `${p.injectionResisted}/${p.injectionFixtures} (${formatPct(p.resistanceRate)})`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollRegion>
            </div>
          </CardContent>
        </Card>
      )}
    </>
  );
}
