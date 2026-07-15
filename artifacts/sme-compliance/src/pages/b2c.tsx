import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import {
  useGetMe,
  useListB2cReports,
  useListB2cReportItems,
  useSubmitB2cReport,
  useListInvoices,
  getListB2cReportsQueryKey,
  getListB2cReportItemsQueryKey,
  type B2cReportBatch,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { FeatureUnavailable } from "@/components/feature-unavailable";
import { RequireClientScope } from "@/components/require-client-scope";
import { SkeletonList } from "@/components/skeleton-list";
import { usePageTitle } from "@/hooks/use-page-title";
import { useToast } from "@/hooks/use-toast";
import { isFeatureDisabled, serverErrorMessage } from "@/lib/errors";
import { idMap } from "@/lib/rows";
import { Store, Clock3, CheckCircle2, ChevronDown, ChevronUp } from "lucide-react";
import {
  formatNaira,
  formatDate,
  formatDateTime,
  batchStatusLabel,
  batchBadgeClasses,
} from "@/lib/format";

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

// Re-render every 30s so the deadline countdown stays live without a refresh.
function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function Countdown({ deadlineAt, now }: { deadlineAt: string; now: number }) {
  const remaining = new Date(deadlineAt).getTime() - now;
  if (Number.isNaN(remaining)) return null;
  if (remaining <= 0) {
    return (
      <span className="inline-flex items-center gap-1 text-sm font-medium text-destructive">
        <Clock3 className="w-4 h-4" aria-hidden="true" /> Deadline passed
      </span>
    );
  }
  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  const urgent = remaining < FOUR_HOURS_MS;
  return (
    <span
      className={`inline-flex items-center gap-1 text-sm font-medium ${
        urgent ? "text-destructive" : "text-foreground"
      }`}
    >
      <Clock3 className="w-4 h-4" aria-hidden="true" />
      {hours}h {String(minutes).padStart(2, "0")}m left to report
    </span>
  );
}

function BatchItems({ batchId }: { batchId: string }) {
  const {
    data: items,
    isLoading,
    isError,
    refetch,
  } = useListB2cReportItems(batchId, {
    query: {
      enabled: !!batchId,
      queryKey: getListB2cReportItemsQueryKey(batchId),
      retry: false,
    },
  });
  const { data: invoices } = useListInvoices();

  const invoiceNumber = useMemo(
    () => idMap(invoices, (inv) => inv.id, (inv) => inv.invoiceNumber),
    [invoices],
  );

  if (isLoading) {
    return (
      <div className="space-y-2 pt-2">
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-wrap items-center gap-3 pt-2">
        <p className="text-sm text-destructive" data-testid="text-error">
          Unable to load this batch's items.
        </p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  if ((items || []).length === 0) {
    return (
      <p className="text-sm text-muted-foreground pt-2">No items in this batch yet.</p>
    );
  }

  return (
    <div className="space-y-2 pt-2">
      {(items || []).map((item) => (
        <div
          key={item.id}
          className="flex items-center justify-between text-sm border rounded-md px-3 py-2"
        >
          <div className="min-w-0">
            <Link
              href={`/invoices/${item.invoiceId}`}
              className="font-medium hover:underline"
            >
              {invoiceNumber.get(item.invoiceId) || `Invoice ${item.invoiceId.slice(0, 8)}…`}
            </Link>
            <p className="text-xs text-muted-foreground">
              Added {formatDate(item.createdAt)}
            </p>
          </div>
          <span className="font-semibold shrink-0 tabular-nums">
            {formatNaira(item.amount)}
          </span>
        </div>
      ))}
    </div>
  );
}

export function B2cReports() {
  usePageTitle("B2C reports");
  const { data: me } = useGetMe();
  const clientPartyId = me?.clientPartyId || "";
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const now = useNow();

  const {
    data: batches,
    isLoading,
    isError,
    error,
    refetch,
  } = useListB2cReports(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getListB2cReportsQueryKey({ clientPartyId }),
        retry: false,
      },
    },
  );

  const submit = useSubmitB2cReport();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [reportingId, setReportingId] = useState<string | null>(null);

  const markReported = async (batch: B2cReportBatch) => {
    setReportingId(batch.id);
    try {
      await submit.mutateAsync({ id: batch.id });
      // Not awaited: a background refetch rejection must not surface as a false
      // "could not mark reported" error after the batch already filed.
      queryClient.invalidateQueries({
        queryKey: getListB2cReportsQueryKey({ clientPartyId }),
      });
      toast({
        title: "Batch reported",
        description: "This B2C window is now filed with the rail.",
      });
    } catch (e) {
      toast({
        title: "Could not mark reported",
        description: serverErrorMessage(e),
        variant: "destructive",
      });
    } finally {
      setReportingId(null);
    }
  };

  if (isFeatureDisabled(error)) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="B2C reports"
          description="Consumer sales are batched into 24-hour windows — report each batch before its deadline."
        />
        <FeatureUnavailable feature="B2C reporting" />
      </div>
    );
  }

  const sorted = [...(batches || [])].sort((a, b) =>
    b.windowStart.localeCompare(a.windowStart),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="B2C reports"
        description="Consumer sales are batched into 24-hour windows — report each batch before its deadline."
      />

      <RequireClientScope thing="B2C reporting batches">
        {isLoading ? (
          <SkeletonList count={3} itemClassName="h-24" />
        ) : isError ? (
          <QueryError thing="your B2C reporting batches" onRetry={() => refetch()} />
        ) : sorted.length === 0 ? (
          <Card>
            <EmptyState
              icon={Store}
              title="No B2C batches yet"
              description="Stamp a consumer (B2C) invoice and a reporting batch opens automatically."
            />
          </Card>
        ) : (
          <div className="space-y-3">
            {sorted.map((batch) => {
              const needsReport =
                batch.status === "open" ||
                (batch.status === "breached" && !batch.reportedAt);
              const expanded = expandedId === batch.id;
              return (
                <Card key={batch.id}>
                  <CardContent className="p-4 space-y-3">
                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold">
                            Window from {formatDateTime(batch.windowStart)}
                          </span>
                          <span className={batchBadgeClasses(batch.status)}>
                            {batchStatusLabel(batch.status)}
                          </span>
                        </div>
                        <p className="text-sm text-muted-foreground mt-1">
                          {batch.itemCount} sale(s) · {formatNaira(batch.totalAmount)} ·
                          Deadline {formatDateTime(batch.deadlineAt)}
                        </p>
                      </div>
                      <div className="flex items-center gap-3 shrink-0 flex-wrap">
                        {batch.status === "open" && (
                          <Countdown deadlineAt={batch.deadlineAt} now={now} />
                        )}
                        {batch.reportedAt && (
                          <span className="inline-flex items-center gap-1 text-sm text-emerald-700 dark:text-emerald-400">
                            <CheckCircle2 className="w-4 h-4" aria-hidden="true" /> Reported{" "}
                            {formatDateTime(batch.reportedAt)}
                          </span>
                        )}
                        {batch.status === "breached" && !batch.reportedAt && (
                          <span className="text-sm font-medium text-destructive">
                            Deadline missed — report now
                          </span>
                        )}
                        {needsReport && (
                          <Button
                            size="sm"
                            onClick={() => markReported(batch)}
                            disabled={reportingId === batch.id}
                          >
                            {reportingId === batch.id ? "Reporting…" : "Mark reported"}
                          </Button>
                        )}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setExpandedId(expanded ? null : batch.id)}
                      aria-expanded={expanded}
                    >
                      {expanded ? (
                        <ChevronUp className="w-4 h-4 mr-1" aria-hidden="true" />
                      ) : (
                        <ChevronDown className="w-4 h-4 mr-1" aria-hidden="true" />
                      )}
                      {expanded ? "Hide items" : `View items (${batch.itemCount})`}
                    </Button>
                    {expanded && <BatchItems batchId={batch.id} />}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </RequireClientScope>
    </div>
  );
}
