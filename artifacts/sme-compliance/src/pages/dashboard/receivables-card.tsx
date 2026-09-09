import {
  useListPaymentBehaviour,
  getListPaymentBehaviourQueryKey,
  type ReceivablesSummary,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/query-error";
import { Download, Wallet } from "lucide-react";
import { Link } from "wouter";
import { formatNaira } from "@/lib/format";
import { showFirstInvoiceCta } from "./helpers";
import { AgingBucketRow } from "./aging-bucket-row";

export function ReceivablesCard({
  summary,
  isLoading,
  isError,
  clientPartyId,
  totalInvoices,
  onRetry,
}: {
  summary: ReceivablesSummary | undefined;
  isLoading: boolean;
  isError: boolean;
  clientPartyId: string;
  totalInvoices: number | undefined;
  onRetry: () => void;
}) {
  const primary = summary?.groups[0];

  // Buyer payment rhythm (round-9 idea #1): per-buyer days-to-pay medians
  // mined server-side from this client's own accepted reconciliation
  // matches. Informational chip only — the per-invoice "beyond their usual"
  // judgement lives on the invoice detail, where both sides of the
  // comparison share the same anchor date.
  const { data: behaviour } = useListPaymentBehaviour(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId && !!summary?.topDebtors.length,
        queryKey: getListPaymentBehaviourQueryKey({ clientPartyId }),
        staleTime: 5 * 60_000,
        retry: false,
      },
    },
  );
  const rhythmByBuyer = new Map(
    (behaviour ?? []).map((b) => [b.buyerPartyId, b.medianDaysToPay]),
  );

  // CSV of the per-invoice rows behind this aging summary, as a plain browser
  // navigation (no query hook): the endpoint answers with a Content-Disposition
  // attachment and auth rides the session cookie.
  const exportCsv = () => {
    window.location.assign(
      `/api/dashboard/receivables/export?clientPartyId=${encodeURIComponent(clientPartyId)}`,
    );
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2.5">
          <span className="mi-card-icon">
            <Wallet aria-hidden="true" />
          </span>
          Receivables
        </CardTitle>
        {!!clientPartyId && !!primary && (
          <Button
            variant="ghost"
            size="sm"
            onClick={exportCsv}
            data-testid="button-export-receivables-csv"
          >
            <Download className="w-4 h-4 mr-1.5" aria-hidden="true" />
            Export CSV
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-8 w-40" />
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : isError ? (
          <QueryError thing="your receivables" onRetry={onRetry} />
        ) : !summary || !primary ? (
          <div
            className="text-sm text-muted-foreground text-center py-4"
            data-testid="text-receivables-empty"
          >
            No outstanding receivables.
            {showFirstInvoiceCta(totalInvoices) && (
              <>
                {" "}
                <Link
                  href="/invoices/new"
                  className="text-primary hover:underline"
                  data-testid="link-first-invoice"
                >
                  Create your first invoice
                </Link>{" "}
                to start tracking what you&apos;re owed.
              </>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <p
                className="text-2xl font-bold tabular-nums"
                data-testid="text-receivables-total"
              >
                {formatNaira(primary.outstandingTotal)}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Outstanding across {primary.invoiceCount} invoice
                {primary.invoiceCount === 1 ? "" : "s"}
                {summary.groups.length > 1
                  ? ` · +${summary.groups.length - 1} more ${
                      summary.groups.length === 2 ? "currency" : "currencies"
                    }`
                  : ""}
              </p>
            </div>
            <div className="space-y-2">
              <AgingBucketRow
                label="Current (≤30d)"
                bucket={primary.buckets.current}
              />
              <AgingBucketRow
                label="31–60 days"
                bucket={primary.buckets.days31to60}
              />
              <AgingBucketRow
                label="61–90 days"
                bucket={primary.buckets.days61to90}
                tone="warning"
              />
              <AgingBucketRow
                label="90+ days"
                bucket={primary.buckets.days90plus}
                tone="danger"
              />
            </div>
            {summary.topDebtors.length > 0 && (
              <div className="pt-3 border-t">
                <p className="text-xs font-medium text-muted-foreground mb-2">
                  Top debtors
                </p>
                <div className="space-y-2">
                  {summary.topDebtors.map((debtor) => (
                    <div
                      key={debtor.buyerPartyId}
                      className="flex items-center justify-between gap-3 text-sm"
                    >
                      <span className="min-w-0 truncate">
                        {debtor.buyerName}
                        {rhythmByBuyer.has(debtor.buyerPartyId) && (
                          <span
                            className="ml-1.5 text-xs text-muted-foreground"
                            data-testid={`rhythm-${debtor.buyerPartyId}`}
                          >
                            usually pays ~
                            {rhythmByBuyer.get(debtor.buyerPartyId)}d
                          </span>
                        )}
                      </span>
                      <span className="shrink-0 font-medium tabular-nums">
                        {formatNaira(debtor.outstanding)}
                        <span className="text-xs text-muted-foreground font-normal">
                          {" "}
                          · {debtor.invoiceCount} inv
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
