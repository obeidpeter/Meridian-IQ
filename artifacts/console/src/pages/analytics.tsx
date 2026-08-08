import { Link } from "wouter";
import {
  getGetComplianceScorecardQueryKey,
  getGetPortfolioQueryKey,
  useGetComplianceScorecard,
  useGetPortfolio,
} from "@workspace/api-client-react";
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  FileWarning,
  Users,
} from "lucide-react";
import {
  Metric,
  MetricStrip,
  WorkQueue,
  WorkspaceHeader,
  type WorkQueueItem,
} from "@workspace/web-ui";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/query-error";
import { usePageTitle } from "@/hooks/use-page-title";
import { formatNaira } from "@/lib/format";

function rate(value: number, total: number) {
  return total > 0 ? Math.round((value / total) * 100) : 0;
}

export function PracticeAnalytics() {
  usePageTitle("Practice analytics");
  const portfolio = useGetPortfolio({
    query: { queryKey: getGetPortfolioQueryKey() },
  });
  const scorecard = useGetComplianceScorecard({
    query: {
      queryKey: getGetComplianceScorecardQueryKey(),
      retry: false,
      staleTime: 60_000,
    },
  });

  if (portfolio.isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-80 w-full" />
      </div>
    );
  }
  if (portfolio.isError || !portfolio.data) {
    return (
      <div className="space-y-6">
        <WorkspaceHeader eyebrow="Performance" title="Practice analytics" />
        <QueryError
          thing="practice analytics"
          onRetry={() => portfolio.refetch()}
        />
      </div>
    );
  }

  const data = portfolio.data;
  const invoiceCount = data.clients.reduce(
    (total, client) => total + client.totalInvoices,
    0,
  );
  const stampedCount = data.clients.reduce(
    (total, client) => total + client.stampedCount,
    0,
  );
  const lowRisk = data.clients.filter(
    (client) => client.penaltyRisk === "low",
  ).length;
  const mediumRisk = data.clients.filter(
    (client) => client.penaltyRisk === "medium",
  ).length;
  const averageWindowRate = (() => {
    const rates = (scorecard.data?.rows ?? [])
      .map((row) => row.withinWindowRate)
      .filter((value): value is number => value !== null);
    if (rates.length === 0) return null;
    return Math.round(
      (rates.reduce((sum, value) => sum + value, 0) / rates.length) * 100,
    );
  })();
  const workItems: WorkQueueItem[] = data.clients
    .filter(
      (client) =>
        client.penaltyRisk === "high" ||
        client.failedCount > 0 ||
        client.overdueCount > 0,
    )
    .slice(0, 8)
    .map((client) => ({
      id: client.clientPartyId,
      title: client.legalName,
      description: [
        client.failedCount > 0 ? `${client.failedCount} failed` : null,
        client.overdueCount > 0 ? `${client.overdueCount} overdue` : null,
        client.unsubmittedCount > 0
          ? `${client.unsubmittedCount} unsubmitted`
          : null,
      ]
        .filter(Boolean)
        .join(" · "),
      tone: client.penaltyRisk === "high" ? "critical" : "warning",
      icon: <AlertTriangle className="size-4" aria-hidden="true" />,
      action: (
        <Button asChild size="sm" variant="outline">
          <Link href={`/clients/${client.clientPartyId}`}>Open client</Link>
        </Button>
      ),
    }));

  return (
    <div className="space-y-6">
      <WorkspaceHeader
        eyebrow="Performance"
        title="Practice analytics"
        description="Client risk, submission outcomes and operational value across the firm."
      />

      <MetricStrip label="Practice summary">
        <Metric
          label="Client book"
          value={String(data.clientCount)}
          detail={`${invoiceCount} invoices recorded`}
          icon={<Users className="size-4" aria-hidden="true" />}
        />
        <Metric
          label="Stamped share"
          value={`${rate(stampedCount, invoiceCount)}%`}
          detail={`${stampedCount} accepted invoices`}
          icon={<CheckCircle2 className="size-4" aria-hidden="true" />}
          tone="positive"
        />
        <Metric
          label="Within window"
          value={averageWindowRate === null ? "—" : `${averageWindowRate}%`}
          detail="Average reported client rate"
          icon={<BarChart3 className="size-4" aria-hidden="true" />}
        />
        <Metric
          label="Unsubmitted value"
          value={formatNaira(data.totalUnsubmittedValue)}
          detail={`${data.totalUnsubmittedCount} invoices`}
          icon={<FileWarning className="size-4" aria-hidden="true" />}
          tone={data.totalUnsubmittedCount > 0 ? "warning" : "default"}
        />
      </MetricStrip>

      <section className="grid gap-8 border-y border-slate-200 bg-white px-5 py-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <div>
          <h2 className="text-base font-bold text-slate-950">
            Risk distribution
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Current client penalty-risk bands.
          </p>
        </div>
        <div className="grid grid-cols-3 divide-x divide-slate-200 border-y border-slate-200">
          {[
            ["Low", lowRisk, "text-emerald-700"],
            ["Medium", mediumRisk, "text-amber-700"],
            ["High", data.highRiskCount, "text-red-700"],
          ].map(([label, value, colour]) => (
            <div key={String(label)} className="px-4 py-5 text-center">
              <p className={`text-3xl font-extrabold tabular-nums ${colour}`}>
                {value}
              </p>
              <p className="mt-1 text-xs font-bold text-slate-500">{label}</p>
            </div>
          ))}
        </div>
      </section>

      <WorkQueue
        title="Performance exceptions"
        description="High-risk, failed or overdue client records needing intervention."
        items={workItems}
        emptyTitle="No client exceptions"
        emptyDescription="No client is currently high risk, failed or overdue."
      />
    </div>
  );
}
