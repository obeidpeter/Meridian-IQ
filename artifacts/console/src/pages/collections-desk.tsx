import { Link } from "wouter";
import {
  getGetFirmReceivablesQueryKey,
  useGetFirmReceivables,
} from "@workspace/api-client-react";
import { Banknote, Clock3, Users, WalletCards } from "lucide-react";
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
import { ReceivablesCard } from "@/pages/portfolio";
import { usePageTitle } from "@/hooks/use-page-title";
import { formatDate } from "@/lib/format";

export function CollectionsDesk() {
  usePageTitle("Collections desk");
  const query = useGetFirmReceivables({
    query: { queryKey: getGetFirmReceivablesQueryKey() },
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
        <WorkspaceHeader eyebrow="Money" title="Collections desk" />
        <QueryError thing="firm receivables" onRetry={() => query.refetch()} />
      </div>
    );
  }

  const data = query.data;
  const invoiceCount = data.clients.reduce(
    (total, client) => total + client.invoiceCount,
    0,
  );
  const agedClients = data.clients.filter(
    (client) => Number(client.overdue90Amount) > 0,
  );
  const currencies = new Set(data.clients.map((client) => client.currency));
  const workItems: WorkQueueItem[] = agedClients.slice(0, 8).map((client) => ({
    id: `${client.clientPartyId}-${client.currency}`,
    title: client.clientName,
    description: `${client.currency} ${client.overdue90Amount} is more than 90 days old${client.oldestDueDate ? ` · oldest due ${formatDate(client.oldestDueDate)}` : ""}.`,
    tone: "warning",
    icon: <Clock3 className="size-4" aria-hidden="true" />,
    action: (
      <Button asChild size="sm" variant="outline">
        <Link href={`/clients/${client.clientPartyId}`}>Open client</Link>
      </Button>
    ),
  }));

  return (
    <div className="space-y-6">
      <WorkspaceHeader
        eyebrow="Money"
        title="Collections desk"
        description="Firm-wide receivables, oldest balances and the client accounts that need follow-up."
      />

      <MetricStrip label="Collections summary">
        <Metric
          label="Client balances"
          value={String(data.clients.length)}
          detail="Client and currency rows"
          icon={<Users className="size-4" aria-hidden="true" />}
        />
        <Metric
          label="Open invoices"
          value={String(invoiceCount)}
          detail="Across the client book"
          icon={<WalletCards className="size-4" aria-hidden="true" />}
        />
        <Metric
          label="90+ day clients"
          value={String(agedClients.length)}
          detail="Highest-priority follow-up"
          icon={<Clock3 className="size-4" aria-hidden="true" />}
          tone={agedClients.length > 0 ? "warning" : "default"}
        />
        <Metric
          label="Currencies"
          value={String(currencies.size)}
          detail="Kept separate in the ledger"
          icon={<Banknote className="size-4" aria-hidden="true" />}
        />
      </MetricStrip>

      <WorkQueue
        title="Aged collection queue"
        description="Client balances older than 90 days, ordered by the server's risk view."
        items={workItems}
        emptyTitle="No 90+ day client balances"
        emptyDescription="The current receivables report has no severely aged balances."
      />

      <ReceivablesCard />
    </div>
  );
}
