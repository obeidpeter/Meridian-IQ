import {
  getGetDashboardSummaryQueryKey,
  getGetReceivablesSummaryQueryKey,
  useGetDashboardSummary,
  useGetMe,
  useGetReceivablesSummary,
} from "@workspace/api-client-react";
import { Banknote, Clock3, Landmark, UsersRound } from "lucide-react";
import { Metric, MetricStrip, WorkspaceHeader } from "@workspace/web-ui";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/query-error";
import {
  CashflowCard,
  ChaseListCard,
  ReceivablesCard,
  UnmatchedCreditsCard,
} from "@/pages/dashboard";
import { usePageTitle } from "@/hooks/use-page-title";
import { formatNaira } from "@/lib/format";

export function Collections() {
  usePageTitle("Collections");
  const { data: me } = useGetMe();
  const clientPartyId = me?.clientPartyId ?? "";
  const receivables = useGetReceivablesSummary(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getGetReceivablesSummaryQueryKey({ clientPartyId }),
      },
    },
  );
  const summary = useGetDashboardSummary(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getGetDashboardSummaryQueryKey({ clientPartyId }),
      },
    },
  );

  if (!me || receivables.isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-28 w-full" />
        <div className="grid gap-6 lg:grid-cols-2">
          <Skeleton className="h-96" />
          <Skeleton className="h-96" />
        </div>
      </div>
    );
  }

  if (receivables.isError) {
    return (
      <div className="space-y-6">
        <WorkspaceHeader
          eyebrow="Money"
          title="Collections"
          description="Prioritise overdue balances and reconcile incoming payments."
        />
        <QueryError
          thing="your collections"
          onRetry={() => receivables.refetch()}
        />
      </div>
    );
  }

  const primary = receivables.data?.groups[0];
  const oldestCount =
    receivables.data?.groups.reduce(
      (total, group) => total + group.buckets.days90plus.count,
      0,
    ) ?? 0;
  const totalInvoices =
    receivables.data?.groups.reduce(
      (total, group) => total + group.invoiceCount,
      0,
    ) ?? 0;

  return (
    <div className="space-y-6">
      <WorkspaceHeader
        eyebrow="Money"
        title="Collections"
        description="A focused receivables desk for ageing, cash timing, buyer follow-up and unmatched money."
      />

      <MetricStrip label="Collections summary">
        <Metric
          label="Outstanding"
          value={primary ? formatNaira(primary.outstandingTotal) : "₦0.00"}
          detail={
            receivables.data && receivables.data.groups.length > 1
              ? `Across ${receivables.data.groups.length} currencies`
              : "Current open balance"
          }
          icon={<Banknote className="size-4" aria-hidden="true" />}
        />
        <Metric
          label="Open invoices"
          value={String(totalInvoices)}
          detail="Across all ageing buckets"
          icon={<Landmark className="size-4" aria-hidden="true" />}
        />
        <Metric
          label="90+ days"
          value={String(oldestCount)}
          detail="Highest-priority balances"
          icon={<Clock3 className="size-4" aria-hidden="true" />}
          tone={oldestCount > 0 ? "warning" : "default"}
        />
        <Metric
          label="Debtors"
          value={String(receivables.data?.topDebtors.length ?? 0)}
          detail="Buyers with open balances"
          icon={<UsersRound className="size-4" aria-hidden="true" />}
        />
      </MetricStrip>

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <ReceivablesCard
          summary={receivables.data}
          isLoading={receivables.isLoading}
          isError={receivables.isError}
          clientPartyId={clientPartyId}
          totalInvoices={summary.data?.totalInvoices}
          onRetry={() => receivables.refetch()}
        />
        <ChaseListCard clientPartyId={clientPartyId} />
        <CashflowCard clientPartyId={clientPartyId} />
        <UnmatchedCreditsCard clientPartyId={clientPartyId} />
      </div>
    </div>
  );
}
