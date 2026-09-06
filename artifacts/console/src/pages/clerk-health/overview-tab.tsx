import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatTile } from "@/components/stat-tile";
import { ScrollRegion } from "@/components/scroll-region";
import {
  formatPct,
  pillClasses,
  type BadgeTone,
} from "@/lib/format";
import { STATUS_TONE } from "@/pages/clerk-shared";
import {
  OUTCOME_TONE,
  fmtMs,
  fmtTokens,
  fmtUsd,
  casesTileDetail,
  type MetricsGuard,
} from "./format";

// The Overview tab of the Clerk health page (R110: split out of the page):
// the headline tiles, cost tiles, status breakdowns and inference cohorts.

export function OverviewTab({ withMetrics }: { withMetrics: MetricsGuard }) {
  return (
    <>
      {withMetrics((metrics) => (
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
                <ScrollRegion label="Inference cohorts table">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                        <th className="py-2 pr-3 font-medium">Model</th>
                        <th className="py-2 pr-3 font-medium">Prompt</th>
                        <th className="py-2 pr-3 font-medium">Purpose</th>
                        <th className="py-2 pr-3 font-medium text-right">
                          Total
                        </th>
                        <th className="py-2 pr-3 font-medium text-right">
                          OK
                        </th>
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
                            <code className="text-xs">
                              {c.promptVersion}
                            </code>
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
                </ScrollRegion>
              )}
            </CardContent>
          </Card>
        </>
      ))}
    </>
  );
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

// Prompt canary (round-5 idea #2): run the eval corpus under a CANDIDATE
// system prompt and the incumbent side by side. Decision support only — the
// verdict rule is deterministic and server-side, nothing is stored, and
// promotion is a code change the operator makes with this evidence in hand.
