import {
  useGetClerkTierReport,
  getGetClerkTierReportQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatTile } from "@/components/stat-tile";
import { ScrollRegion } from "@/components/scroll-region";
import { formatPct, pillClasses } from "@/lib/format";
import { fmtTokens, fmtUsd, type MetricsGuard } from "./format";

// The Economics tab of the Clerk health page (R110: split out of the page):
// spend and token metrics and the model-tier evidence with its own query.

export function EconomicsTab({ withMetrics }: { withMetrics: MetricsGuard }) {
  // Tier-suggestion report (round-9 idea #3): pure ledger SQL, so it loads
  // eagerly like the metrics — no model call, no cost to a page view.
  const { data: tierReport } = useGetClerkTierReport({
    query: {
      queryKey: getGetClerkTierReportQueryKey(),
      staleTime: 5 * 60_000,
      retry: false,
    },
  });

  return (
    <>
      {withMetrics((metrics) => (
        <>
          <Card data-testid="section-unit-economics">
            <CardHeader>
              <CardTitle className="text-base">
                Unit economics — where the tokens go
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              {metrics.economics.byPurpose.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No inference calls in this window.
                </p>
              ) : (
                <ScrollRegion label="Token spend by purpose table">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                        <th className="py-2 pr-3 font-medium">Purpose</th>
                        <th className="py-2 pr-3 font-medium text-right">
                          Calls
                        </th>
                        <th className="py-2 pr-3 font-medium text-right">
                          Prompt tk
                        </th>
                        <th className="py-2 pr-3 font-medium text-right">
                          Completion tk
                        </th>
                        <th className="py-2 pr-3 font-medium text-right">
                          Errors
                        </th>
                        <th className="py-2 font-medium text-right">
                          Est. spend
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {metrics.economics.byPurpose.map((p) => (
                        <tr
                          key={p.purpose}
                          data-testid={`row-economics-${p.purpose}`}
                        >
                          <td className="py-2 pr-3">{p.purpose}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {p.calls}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {fmtTokens(p.promptTokens)}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {fmtTokens(p.completionTokens)}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {p.errorCount}
                          </td>
                          <td className="py-2 text-right tabular-nums">
                            {fmtUsd(p.estimatedUsd)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </ScrollRegion>
              )}

              <div data-testid="economics-months">
                <p className="text-xs font-medium text-muted-foreground uppercase mb-2">
                  Failure taxonomy by month
                </p>
                {metrics.economics.months.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No inference history yet.
                  </p>
                ) : (
                  <ScrollRegion label="Failure taxonomy by month table">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                          <th className="py-2 pr-3 font-medium">Month</th>
                          <th className="py-2 pr-3 font-medium text-right">
                            Calls
                          </th>
                          <th className="py-2 pr-3 font-medium text-right">
                            OK
                          </th>
                          <th className="py-2 pr-3 font-medium text-right">
                            Invalid
                          </th>
                          <th className="py-2 pr-3 font-medium text-right">
                            Killed
                          </th>
                          <th className="py-2 font-medium text-right">Error</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {metrics.economics.months.map((m) => (
                          <tr
                            key={m.month}
                            data-testid={`row-economics-month-${m.month}`}
                          >
                            <td className="py-2 pr-3 tabular-nums">
                              {m.month}
                            </td>
                            <td className="py-2 pr-3 text-right tabular-nums">
                              {m.calls}
                            </td>
                            <td className="py-2 pr-3 text-right tabular-nums">
                              {m.okCount}
                            </td>
                            <td className="py-2 pr-3 text-right tabular-nums">
                              {m.invalidCount}
                            </td>
                            <td className="py-2 pr-3 text-right tabular-nums">
                              {m.killedCount}
                            </td>
                            <td className="py-2 text-right tabular-nums">
                              {m.errorCount}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </ScrollRegion>
                )}
              </div>
            </CardContent>
          </Card>

          <Card data-testid="section-platform-spend">
            <CardHeader>
              <CardTitle className="text-base">
                Platform spend — {metrics.platformSpend.month}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <StatTile
                  label="Tokens month-to-date"
                  value={metrics.platformSpend.totalTokens.toLocaleString()}
                  testId="stat-spend-total"
                />
                <StatTile
                  label="Projected this month"
                  value={metrics.platformSpend.projectedTokens.toLocaleString()}
                  testId="stat-spend-projected"
                />
                <StatTile
                  label="Est. cost"
                  value={
                    metrics.platformSpend.estimatedUsd != null
                      ? `$${metrics.platformSpend.estimatedUsd.toFixed(2)}`
                      : "—"
                  }
                  testId="stat-spend-usd"
                />
                <StatTile
                  label="Projected cost"
                  value={
                    metrics.platformSpend.projectedUsd != null
                      ? `$${metrics.platformSpend.projectedUsd.toFixed(2)}`
                      : "—"
                  }
                  testId="stat-spend-projected-usd"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {metrics.platformSpend.firmFundedTokens.toLocaleString()} tokens
                firm-funded ·{" "}
                {metrics.platformSpend.platformFundedTokens.toLocaleString()}{" "}
                platform-funded (desk tooling, evals). Ledger totals on the same
                UTC month boundary the per-firm budgets use; cost estimates need
                CLERK_COST_PER_1M_INPUT_USD / _OUTPUT_USD set.
              </p>
            </CardContent>
          </Card>
        </>
      ))}

      {tierReport && tierReport.rows.length > 0 && (
        <Card data-testid="section-tier-report">
          <CardHeader>
            <CardTitle className="text-base">Model-tier evidence</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Trailing {tierReport.windowDays} days from the inference ledger,
              joined with the tier map in force (base model{" "}
              <span className="font-mono">{tierReport.baseModel}</span>).
              Recommendations are deterministic; act on them via
              CLERK_MODEL_TIERS (takes effect on server restart) and validate
              with a prompt canary first.
            </p>
            <ScrollRegion label="Model-tier evidence table">
              <table className="w-full text-sm" data-testid="table-tier-report">
                <thead>
                  <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Purpose</th>
                    <th className="py-2 pr-3 font-medium text-right">Calls</th>
                    <th className="py-2 pr-3 font-medium text-right">Tokens</th>
                    <th className="py-2 pr-3 font-medium text-right">Share</th>
                    <th className="py-2 pr-3 font-medium text-right">Valid</th>
                    <th className="py-2 pr-3 font-medium">Model</th>
                    <th className="py-2 font-medium">Recommendation</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {tierReport.rows.map((r) => (
                    <tr key={r.purpose}>
                      <td className="py-2 pr-3 font-mono text-xs">
                        {r.purpose}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {r.calls}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {r.totalTokens.toLocaleString()}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {formatPct(r.spendShare)}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {formatPct(r.validRate)}
                      </td>
                      <td className="py-2 pr-3 font-mono text-xs">
                        {r.currentModel}
                        {r.tiered ? " (tier)" : ""}
                      </td>
                      <td className="py-2" title={r.reason}>
                        <span
                          className={pillClasses(
                            r.recommendation === "candidate"
                              ? "emerald"
                              : r.recommendation === "tiered"
                                ? "blue"
                                : r.recommendation === "revert"
                                  ? "red"
                                  : "slate",
                          )}
                        >
                          {r.recommendation.replace("_", " ")}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollRegion>
          </CardContent>
        </Card>
      )}
    </>
  );
}
