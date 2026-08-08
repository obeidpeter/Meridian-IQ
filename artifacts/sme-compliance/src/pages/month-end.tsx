import { Link } from "wouter";
import {
  getGetMonthEndCloseQueryKey,
  useGetMe,
  useGetMonthEndClose,
} from "@workspace/api-client-react";
import {
  AlertTriangle,
  CalendarCheck2,
  CheckCircle2,
  Clock3,
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
import { MonthEndCloseCard } from "@/pages/dashboard";
import { usePageTitle } from "@/hooks/use-page-title";
import { formatDate } from "@/lib/format";

function destinationFor(key: string) {
  if (/receiv|chase|credit|cash/i.test(key)) return "/collections";
  if (/bill|payable/i.test(key)) return "/bills";
  if (/reconcil|statement/i.test(key)) return "/reconciliation";
  if (/vat|filing|tax/i.test(key)) return "/filings";
  return "/invoices";
}

export function MonthEnd() {
  usePageTitle("Month-end close");
  const { data: me } = useGetMe();
  const clientPartyId = me?.clientPartyId ?? "";
  const query = useGetMonthEndClose(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getGetMonthEndCloseQueryKey({ clientPartyId }),
        staleTime: 5 * 60_000,
        retry: false,
      },
    },
  );

  if (query.isLoading || !me) {
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
        <WorkspaceHeader
          eyebrow="Close"
          title="Month-end"
          description="Review the records that need attention before the books move forward."
        />
        <QueryError
          thing="the month-end close"
          onRetry={() => query.refetch()}
        />
      </div>
    );
  }

  const close = query.data;
  const workItems: WorkQueueItem[] = close.items
    .filter((item) => item.status === "attention")
    .map((item) => ({
      id: item.key,
      title: item.label,
      description: item.detail,
      meta:
        item.count > 0
          ? `${item.count} item${item.count === 1 ? "" : "s"}`
          : undefined,
      tone: "warning",
      icon: <AlertTriangle className="size-4" aria-hidden="true" />,
      action: (
        <Button asChild size="sm" variant="outline">
          <Link href={destinationFor(item.key)}>Review</Link>
        </Button>
      ),
    }));

  return (
    <div className="space-y-6">
      <WorkspaceHeader
        eyebrow="Close"
        title="Month-end"
        description="A single control room for unresolved paper, money checks, filings and approved Clerk automation."
        status={
          close.attentionCount > 0 ? (
            <span className="rounded-md bg-amber-100 px-2.5 py-1 text-xs font-bold text-amber-900">
              Review required
            </span>
          ) : (
            <span className="rounded-md bg-emerald-100 px-2.5 py-1 text-xs font-bold text-emerald-900">
              Ready to close
            </span>
          )
        }
      />

      <MetricStrip label="Month-end status">
        <Metric
          label="Needs review"
          value={String(close.attentionCount)}
          detail="Checks requiring action"
          icon={<AlertTriangle className="size-4" aria-hidden="true" />}
          tone={close.attentionCount > 0 ? "warning" : "default"}
        />
        <Metric
          label="Clear checks"
          value={String(close.items.length - close.attentionCount)}
          detail={`${close.items.length} total controls`}
          icon={<CheckCircle2 className="size-4" aria-hidden="true" />}
          tone="positive"
        />
        <Metric
          label="As of"
          value={formatDate(close.asOf)}
          detail="Latest close snapshot"
          icon={<Clock3 className="size-4" aria-hidden="true" />}
        />
        <Metric
          label="Close mode"
          value="Human reviewed"
          detail="Clerk actions remain approval-gated"
          icon={<CalendarCheck2 className="size-4" aria-hidden="true" />}
          tone="info"
        />
      </MetricStrip>

      <WorkQueue
        title="Close blockers"
        description="Resolve these checks before treating the month as complete."
        items={workItems}
        emptyTitle="Every close check is clear"
        emptyDescription="The current snapshot has no unresolved controls."
      />

      <div className="max-w-4xl">
        <MonthEndCloseCard clientPartyId={clientPartyId} />
      </div>
    </div>
  );
}
