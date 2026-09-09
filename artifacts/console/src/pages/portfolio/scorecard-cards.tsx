import { Link } from "wouter";
import {
  useGetClerkAdoptionReport,
  getGetClerkAdoptionReportQueryKey,
  useGetComplianceScorecard,
  getGetComplianceScorecardQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollRegion } from "@/components/scroll-region";
import {
  ListChecks,
  Sparkles,
  TrendingUp,
  TrendingDown,
  Minus,
} from "lucide-react";
import { formatDate, formatPct } from "@/lib/format";

// Client compliance scorecard (round-19 idea #3): the cross-client posture
// league table, attention first — pure SQL server-side, sample floors on
// every rate. A prioritization aid, not a verdict (the note says so).
// Renders only on success with a non-empty book.
export function ComplianceScorecardCard() {
  const { data: scorecard, isSuccess } = useGetComplianceScorecard({
    query: { queryKey: getGetComplianceScorecardQueryKey(), retry: false },
  });
  if (!isSuccess || !scorecard || scorecard.rows.length === 0) return null;
  const pct = (value: number | null) =>
    value === null ? "—" : formatPct(value);
  // Trend vs the prior window (round 20): direction only when both windows
  // carry a rate; `goodWhenUp` maps improvement to green for both metrics.
  const trend = (
    current: number | null,
    prev: number | null,
    goodWhenUp: boolean,
  ) => {
    if (current === null || prev === null) return null;
    const delta = current - prev;
    if (Math.abs(delta) < 0.01) {
      return (
        <Minus
          className="ml-1 inline w-3.5 h-3.5 text-muted-foreground"
          aria-label="unchanged vs the prior window"
        />
      );
    }
    const up = delta > 0;
    const good = up === goodWhenUp;
    const Icon = up ? TrendingUp : TrendingDown;
    return (
      <Icon
        className={`ml-1 inline w-3.5 h-3.5 ${good ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}
        aria-label={`${up ? "up" : "down"} vs the prior window`}
      />
    );
  };
  return (
    <Card className="shadow-sm" data-testid="card-compliance-scorecard">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ListChecks className="w-4 h-4 text-primary" aria-hidden="true" />
          Compliance scorecard — last {scorecard.windowDays} days
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <ScrollRegion label="Compliance scorecard table">
          <table
            className="w-full text-sm"
            data-testid="table-compliance-scorecard"
          >
            <thead>
              <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Client</th>
                <th className="py-2 pr-3 font-medium text-right">Issued</th>
                <th className="py-2 pr-3 font-medium text-right">In window</th>
                <th className="py-2 pr-3 font-medium text-right">Failures</th>
                <th className="py-2 pr-3 font-medium text-right">
                  Days to stamp
                </th>
                <th className="py-2 pr-3 font-medium text-right">
                  Overdue now
                </th>
                <th className="py-2 font-medium text-right">
                  Unverified bills
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {scorecard.rows.slice(0, 10).map((r) => (
                <tr
                  key={r.clientPartyId}
                  data-testid={`row-scorecard-${r.clientPartyId}`}
                >
                  <td className="py-2 pr-3 max-w-[16rem] truncate">
                    <Link
                      href={`/clients/${r.clientPartyId}`}
                      className="hover:underline rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    >
                      {r.clientName}
                    </Link>
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {r.issuedCount}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {pct(r.withinWindowRate)}
                    {trend(r.withinWindowRate, r.prevWithinWindowRate, true)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {pct(r.failureRate)}
                    {trend(r.failureRate, r.prevFailureRate, false)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {r.medianDaysToStamp === null
                      ? "—"
                      : `${r.medianDaysToStamp}d`}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {r.overdueNow > 0 ? (
                      <span className="font-medium text-red-500 dark:text-red-400">
                        {r.overdueNow}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {r.unverifiedBills > 0 ? r.unverifiedBills : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
        <p className="text-xs text-muted-foreground">{scorecard.note}</p>
      </CardContent>
    </Card>
  );
}

// Clerk adoption & impact (round-10 idea #3): per-client capture volume,
// kept-rate and review turnaround — the "is Clerk working for us" numbers.
// Renders only when clients have approved captures in the window.
export function ClerkAdoptionCard() {
  const { data: report, isSuccess } = useGetClerkAdoptionReport({
    query: { queryKey: getGetClerkAdoptionReportQueryKey(), retry: false },
  });
  if (!isSuccess || !report || report.clients.length === 0) return null;
  return (
    <Card className="shadow-sm" data-testid="card-clerk-adoption">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="w-4 h-4 text-primary" aria-hidden="true" />
          Clerk adoption &amp; impact
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Last {report.windowDays} days: {report.totals.extractionCases}{" "}
          documents read, {report.totals.approvedCases} approved into invoices (
          {formatPct(report.totals.approvedShare)});{" "}
          {formatPct(report.totals.keptRate)} of extracted fields kept
          unchanged. Computed from your own cases — no AI involved.
        </p>
        <ScrollRegion label="Clerk adoption table">
          <table className="w-full text-sm" data-testid="table-clerk-adoption">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Client</th>
                <th className="py-2 pr-3 font-medium text-right">Approved</th>
                <th className="py-2 pr-3 font-medium text-right">Kept</th>
                <th className="py-2 pr-3 font-medium text-right">
                  Review time
                </th>
                <th className="py-2 font-medium text-right">Last approved</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {report.clients.slice(0, 8).map((c) => (
                <tr
                  key={c.clientPartyId}
                  data-testid={`row-adoption-${c.clientPartyId}`}
                >
                  <td className="py-2 pr-3 max-w-[16rem] truncate">
                    {c.clientName}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {c.approvedCases}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {c.fieldsCompared === 0 ? "—" : formatPct(c.keptRate)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {c.avgReviewMinutes == null
                      ? "—"
                      : `${c.avgReviewMinutes}m`}
                  </td>
                  <td className="py-2 text-right text-xs text-muted-foreground">
                    {formatDate(c.lastApprovedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
      </CardContent>
    </Card>
  );
}
