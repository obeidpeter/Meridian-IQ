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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Store, Clock3, Lock, CheckCircle2, ChevronDown, ChevronUp } from "lucide-react";
import { formatNaira, formatDate } from "@/lib/format";

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status?: unknown }).status === 404
  );
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const BATCH_BADGES: Record<string, string> = {
  open: "bg-amber-100 text-amber-800 border-amber-200",
  reported: "bg-emerald-100 text-emerald-800 border-emerald-200",
  breached: "bg-red-100 text-red-800 border-red-200",
};

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
        <Clock3 className="w-4 h-4" /> Deadline passed
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
      <Clock3 className="w-4 h-4" />
      {hours}h {String(minutes).padStart(2, "0")}m left to report
    </span>
  );
}

function BatchItems({ batchId }: { batchId: string }) {
  const { data: items, isLoading } = useListB2cReportItems(batchId, {
    query: {
      enabled: !!batchId,
      queryKey: getListB2cReportItemsQueryKey(batchId),
      retry: false,
    },
  });
  const { data: invoices } = useListInvoices();

  const invoiceNumber = useMemo(() => {
    const map = new Map<string, string>();
    (invoices || []).forEach((inv) => map.set(inv.id, inv.invoiceNumber));
    return map;
  }, [invoices]);

  if (isLoading) {
    return (
      <div className="space-y-2 pt-2">
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
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
          <span className="font-semibold shrink-0">{formatNaira(item.amount)}</span>
        </div>
      ))}
    </div>
  );
}

export function B2cReports() {
  const { data: me } = useGetMe();
  const clientPartyId = me?.clientPartyId || "";
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const now = useNow();

  const {
    data: batches,
    isLoading,
    error,
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
      await queryClient.invalidateQueries();
      toast({
        title: "Batch reported",
        description: "This B2C window is now filed with the rail.",
      });
    } catch (e) {
      toast({
        title: "Could not mark reported",
        description: e instanceof Error ? e.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setReportingId(null);
    }
  };

  if (isNotFound(error)) {
    return (
      <div className="space-y-6 animate-in fade-in duration-500">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">B2C Reports</h1>
          <p className="text-muted-foreground">
            24-hour reporting windows for your consumer sales.
          </p>
        </div>
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <Lock className="w-10 h-10 text-muted-foreground mb-3" />
            <p className="font-medium">B2C reporting is not yet enabled for this firm</p>
            <p className="text-sm text-muted-foreground">
              Ask your operator to enable it, then your consumer sales batches will appear
              here.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const sorted = [...(batches || [])].sort((a, b) =>
    b.windowStart.localeCompare(a.windowStart),
  );

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">B2C Reports</h1>
        <p className="text-muted-foreground">
          Consumer sales are batched into 24-hour windows — report each batch before its
          deadline.
        </p>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      ) : sorted.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <Store className="w-10 h-10 text-muted-foreground mb-3" />
            <p className="font-medium">No B2C batches yet</p>
            <p className="text-sm text-muted-foreground">
              Stamp a consumer (B2C) invoice and a reporting batch opens automatically.
            </p>
          </CardContent>
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
                      <div className="flex items-center gap-2">
                        <span className="font-semibold">
                          Window from {formatDateTime(batch.windowStart)}
                        </span>
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full border capitalize ${
                            BATCH_BADGES[batch.status] ||
                            "bg-slate-100 text-slate-600 border-slate-200"
                          }`}
                        >
                          {batch.status}
                        </span>
                      </div>
                      <p className="text-sm text-muted-foreground mt-1">
                        {batch.itemCount} sale(s) · {formatNaira(batch.totalAmount)} ·
                        Deadline {formatDateTime(batch.deadlineAt)}
                      </p>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      {batch.status === "open" && (
                        <Countdown deadlineAt={batch.deadlineAt} now={now} />
                      )}
                      {batch.reportedAt && (
                        <span className="inline-flex items-center gap-1 text-sm text-emerald-700">
                          <CheckCircle2 className="w-4 h-4" /> Reported{" "}
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
                  >
                    {expanded ? (
                      <ChevronUp className="w-4 h-4 mr-1" />
                    ) : (
                      <ChevronDown className="w-4 h-4 mr-1" />
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
    </div>
  );
}
