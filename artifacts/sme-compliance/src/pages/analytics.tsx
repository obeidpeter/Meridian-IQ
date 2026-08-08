import { Link } from "wouter";
import {
  getGetDashboardSummaryQueryKey,
  getGetReceivablesSummaryQueryKey,
  useGetDashboardSummary,
  useGetMe,
  useGetReceivablesSummary,
} from "@workspace/api-client-react";
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Clock3,
  FileWarning,
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

function percentage(part: number, total: number) {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

function StatusBar({
  label,
  value,
  total,
  colour,
}: {
  label: string;
  value: number;
  total: number;
  colour: string;
}) {
  const pct = percentage(value, total);
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)_4rem] items-center gap-3">
      <span className="text-sm font-medium text-slate-700">{label}</span>
      <div className="h-2.5 overflow-hidden rounded-sm bg-slate-100">
        <div
          className={`h-full ${colour}`}
          style={{ width: `${pct}%` }}
          aria-hidden="true"
        />
      </div>
      <span className="text-right text-xs font-bold tabular-nums text-slate-700">
        {value} · {pct}%
      </span>
    </div>
  );
}

export function Analytics() {
  usePageTitle("Analytics");
  const { data: me } = useGetMe();
  const clientPartyId = me?.clientPartyId ?? "";
  const dashboard = useGetDashboardSummary(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getGetDashboardSummaryQueryKey({ clientPartyId }),
      },
    },
  );
  const receivables = useGetReceivablesSummary(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getGetReceivablesSummaryQueryKey({ clientPartyId }),
      },
    },
  );

  if (!me || dashboard.isLoading || receivables.isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-80 w-full" />
      </div>
    );
  }

  if (dashboard.isError || !dashboard.data) {
    return (
      <div className="space-y-6">
        <WorkspaceHeader
          eyebrow="Performance"
          title="Decision analytics"
          description="Track operating outcomes from the records already in MeridianIQ."
        />
        <QueryError
          thing="your analytics"
          onRetry={() => dashboard.refetch()}
        />
      </div>
    );
  }

  const summary = dashboard.data;
  const decided = summary.stampedCount + summary.failedCount;
  const successRate = percentage(summary.stampedCount, decided);
  const oldest =
    receivables.data?.groups.reduce(
      (total, group) => total + group.buckets.days90plus.count,
      0,
    ) ?? 0;
  const outstanding =
    receivables.data?.groups.reduce(
      (total, group) => total + Number(group.outstandingTotal),
      0,
    ) ?? 0;
  const workItems: WorkQueueItem[] = [];

  if (summary.failedCount > 0) {
    workItems.push({
      id: "failed",
      title: `${summary.failedCount} submission failure${summary.failedCount === 1 ? "" : "s"}`,
      description: "These failures reduce the current submission success rate.",
      tone: "critical",
      icon: <FileWarning className="size-4" aria-hidden="true" />,
      action: (
        <Button asChild size="sm" variant="outline">
          <Link href="/invoices">Resolve</Link>
        </Button>
      ),
    });
  }
  if (summary.atRiskCount > 0) {
    workItems.push({
      id: "at-risk",
      title: `${summary.atRiskCount} invoice${summary.atRiskCount === 1 ? "" : "s"} approaching penalty risk`,
      description: "Act before the statutory reporting window closes.",
      tone: "warning",
      icon: <AlertTriangle className="size-4" aria-hidden="true" />,
      action: (
        <Button asChild size="sm" variant="outline">
          <Link href="/calendar">Review</Link>
        </Button>
      ),
    });
  }
  if (oldest > 0) {
    workItems.push({
      id: "aged",
      title: `${oldest} balance${oldest === 1 ? "" : "s"} are over 90 days old`,
      description: "Move the oldest balances to the top of the chase queue.",
      tone: "warning",
      icon: <Clock3 className="size-4" aria-hidden="true" />,
      action: (
        <Button asChild size="sm" variant="outline">
          <Link href="/collections">Open collections</Link>
        </Button>
      ),
    });
  }

  return (
    <div className="space-y-6">
      <WorkspaceHeader
        eyebrow="Performance"
        title="Decision analytics"
        description="Submission quality, money exposure and the next actions that can improve both."
      />

      <MetricStrip label="Performance summary">
        <Metric
          label="Submission success"
          value={`${successRate}%`}
          detail={`${summary.stampedCount} accepted of ${decided} decided`}
          icon={<CheckCircle2 className="size-4" aria-hidden="true" />}
          tone={
            successRate >= 90
              ? "positive"
              : successRate < 70
                ? "warning"
                : "default"
          }
        />
        <Metric
          label="Unsubmitted value"
          value={formatNaira(summary.unsubmittedValue)}
          detail={`${summary.unsubmittedCount} invoice${summary.unsubmittedCount === 1 ? "" : "s"}`}
          icon={<FileWarning className="size-4" aria-hidden="true" />}
          tone={summary.unsubmittedCount > 0 ? "warning" : "default"}
        />
        <Metric
          label="Outstanding"
          value={formatNaira(String(outstanding))}
          detail="Across open receivables"
          icon={<BarChart3 className="size-4" aria-hidden="true" />}
        />
        <Metric
          label="Penalty risk"
          value={summary.penaltyRisk}
          detail={`${summary.atRiskCount} invoices at risk`}
          icon={<AlertTriangle className="size-4" aria-hidden="true" />}
          tone={summary.penaltyRisk === "high" ? "critical" : "default"}
        />
      </MetricStrip>

      <section
        className="grid gap-8 border-y border-slate-200 bg-white px-5 py-6 lg:grid-cols-[minmax(0,1fr)_19rem]"
        aria-labelledby="invoice-outcomes-title"
      >
        <div>
          <h2
            id="invoice-outcomes-title"
            className="text-base font-bold text-slate-950"
          >
            Invoice outcomes
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Current record distribution across the invoice lifecycle.
          </p>
          <div className="mt-6 space-y-4">
            <StatusBar
              label="Accepted"
              value={summary.stampedCount}
              total={summary.totalInvoices}
              colour="bg-emerald-500"
            />
            <StatusBar
              label="Pending"
              value={summary.pendingCount}
              total={summary.totalInvoices}
              colour="bg-sky-500"
            />
            <StatusBar
              label="Draft"
              value={summary.draftCount}
              total={summary.totalInvoices}
              colour="bg-slate-400"
            />
            <StatusBar
              label="Failed"
              value={summary.failedCount}
              total={summary.totalInvoices}
              colour="bg-rose-500"
            />
          </div>
        </div>
        <div className="border-t border-slate-200 pt-5 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0">
          <p className="text-xs font-bold text-slate-500">Total record</p>
          <p className="mt-2 text-4xl font-extrabold tabular-nums text-slate-950">
            {summary.totalInvoices}
          </p>
          <p className="mt-3 text-sm leading-6 text-slate-600">
            This view uses recorded outcomes only. It does not estimate future
            acceptance or collection.
          </p>
        </div>
      </section>

      <WorkQueue
        title="Recommended actions"
        description="The highest-leverage record changes based on current outcomes."
        items={workItems}
        emptyTitle="No negative outcome needs action"
        emptyDescription="There are no failed submissions, at-risk invoices or 90+ day balances."
      />
    </div>
  );
}
