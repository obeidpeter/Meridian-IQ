import { Link } from "wouter";
import {
  getGetFilingMatrixQueryKey,
  useGetFilingMatrix,
} from "@workspace/api-client-react";
import {
  AlertTriangle,
  CalendarCheck2,
  CheckCircle2,
  Clock3,
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
import { FilingMatrixCard } from "@/components/filing-matrix-card";
import { usePageTitle } from "@/hooks/use-page-title";

export function FilingDesk() {
  usePageTitle("Filing desk");
  const query = useGetFilingMatrix({
    query: { queryKey: getGetFilingMatrixQueryKey(), retry: false },
  });

  if (query.isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }
  if (query.isError || !query.data) {
    return (
      <div className="space-y-6">
        <WorkspaceHeader eyebrow="Compliance" title="Filing desk" />
        <QueryError thing="the filing desk" onRetry={() => query.refetch()} />
      </div>
    );
  }

  const matrix = query.data;
  const workItems: WorkQueueItem[] = matrix.rows
    .filter((row) =>
      [row.vat, row.paye, row.wht].some((status) => status === "upcoming"),
    )
    .slice(0, 8)
    .map((row) => {
      const pending = [
        row.vat === "upcoming" ? "VAT" : null,
        row.paye === "upcoming" ? "PAYE" : null,
        row.wht === "upcoming" ? "WHT" : null,
      ].filter(Boolean);
      return {
        id: row.clientPartyId,
        title: row.clientName,
        description: `${pending.join(", ")} ${pending.length === 1 ? "return is" : "returns are"} not prepared.`,
        tone: "warning",
        icon: <Clock3 className="size-4" aria-hidden="true" />,
        action: (
          <Button asChild size="sm" variant="outline">
            <Link href={`/clients/${row.clientPartyId}`}>Open client</Link>
          </Button>
        ),
      };
    });

  return (
    <div className="space-y-6">
      <WorkspaceHeader
        eyebrow="Compliance"
        title="Filing desk"
        description={`${matrix.periodLabel} return status across the client book, ordered for partner action.`}
        status={
          matrix.totals.overdue > 0 ? (
            <span className="rounded-md bg-red-100 px-2.5 py-1 text-xs font-bold text-red-900">
              {matrix.totals.overdue} overdue
            </span>
          ) : (
            <span className="rounded-md bg-emerald-100 px-2.5 py-1 text-xs font-bold text-emerald-900">
              No overdue returns
            </span>
          )
        }
      />

      <MetricStrip label="Filing summary">
        <Metric
          label="Clients"
          value={String(matrix.totals.clients)}
          detail="In this filing period"
          icon={<Users className="size-4" aria-hidden="true" />}
        />
        <Metric
          label="Filed"
          value={String(matrix.totals.filed)}
          detail="Return cells complete"
          icon={<CheckCircle2 className="size-4" aria-hidden="true" />}
          tone="positive"
        />
        <Metric
          label="Unfiled"
          value={String(matrix.totals.unfiled)}
          detail="Still in the filing cycle"
          icon={<CalendarCheck2 className="size-4" aria-hidden="true" />}
          tone={matrix.totals.unfiled > 0 ? "warning" : "default"}
        />
        <Metric
          label="Overdue"
          value={String(matrix.totals.overdue)}
          detail="Past the statutory due date"
          icon={<AlertTriangle className="size-4" aria-hidden="true" />}
          tone={matrix.totals.overdue > 0 ? "critical" : "default"}
        />
      </MetricStrip>

      <WorkQueue
        title="Preparation queue"
        description="Clients with at least one return still in upcoming status."
        items={workItems}
        emptyTitle="Every return is prepared or filed"
        emptyDescription="There are no unstarted returns in the current matrix."
      />

      <FilingMatrixCard />
    </div>
  );
}
