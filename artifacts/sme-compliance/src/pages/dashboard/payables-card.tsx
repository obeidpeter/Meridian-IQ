import {
  useGetPayablesSummary,
  getGetPayablesSummaryQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Receipt } from "lucide-react";
import { Link } from "wouter";
import { formatNaira } from "@/lib/format";
import { dueLaterBucket } from "./helpers";
import { AgingBucketRow } from "./aging-bucket-row";

// Committed outflows — the payables mirror of the receivables card, fed by
// the bills book (supplier invoices where this client is the buyer).
// Render-on-success: while loading, on error, or with nothing committed the
// card is simply absent, like the other advisory dashboard cards.
export function PayablesCard({ clientPartyId }: { clientPartyId: string }) {
  const { data: summary, isSuccess } = useGetPayablesSummary(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getGetPayablesSummaryQueryKey({ clientPartyId }),
        staleTime: 5 * 60_000,
        retry: false,
      },
    },
  );
  const primary = summary?.groups[0];
  if (!isSuccess || !summary || !primary) return null;
  return (
    <Card data-testid="card-payables">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Receipt className="w-5 h-5" aria-hidden="true" /> Payables
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div>
            <p
              className="text-2xl font-bold tabular-nums"
              data-testid="text-payables-total"
            >
              {formatNaira(primary.total.amount)}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Committed across {primary.total.count} bill
              {primary.total.count === 1 ? "" : "s"}
              {summary.groups.length > 1
                ? ` · +${summary.groups.length - 1} more ${
                    summary.groups.length === 2 ? "currency" : "currencies"
                  }`
                : ""}
            </p>
          </div>
          <div className="space-y-2">
            <AgingBucketRow
              label="Overdue"
              bucket={primary.overdue}
              tone="danger"
            />
            <AgingBucketRow
              label="Due this week"
              bucket={primary.dueWeeks[0] ?? { amount: "0", count: 0 }}
              tone="warning"
            />
            <AgingBucketRow
              label="Due later"
              bucket={dueLaterBucket(primary)}
            />
          </div>
          {summary.topSuppliers.length > 0 && (
            <div className="pt-3 border-t">
              <p className="text-xs font-medium text-muted-foreground mb-2">
                Top suppliers
              </p>
              <div className="space-y-2">
                {summary.topSuppliers.map((supplier) => (
                  <div
                    key={supplier.supplierPartyId}
                    className="flex items-center justify-between gap-3 text-sm"
                    data-testid={`payables-supplier-${supplier.supplierPartyId}`}
                  >
                    <span className="min-w-0 truncate">
                      {supplier.supplierName}
                    </span>
                    <span className="shrink-0 font-medium tabular-nums">
                      {formatNaira(supplier.amount)}
                      <span className="text-xs text-muted-foreground font-normal">
                        {" "}
                        · {supplier.count} bill{supplier.count === 1 ? "" : "s"}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <Link
            href="/bills"
            className="text-primary text-sm inline-block hover:underline"
            data-testid="link-view-bills"
          >
            View bills
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
