import { Link } from "wouter";
import {
  getGetFirmReceivablesQueryKey,
  useGetFirmReceivables,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/query-error";
import { ScrollRegion } from "@/components/scroll-region";
import { formatDate } from "@/lib/format";
import { formatMoney } from "./format";

// Firm-level receivables: one row per client per currency, worst-first from
// the API. Loads independently of the portfolio query so a failure here
// never blanks the risk view above it.
export function ReceivablesCard() {
  const { data, isLoading, error, refetch } = useGetFirmReceivables({
    query: { queryKey: getGetFirmReceivablesQueryKey() },
  });

  return (
    <Card className="shadow-sm" data-testid="card-receivables">
      <CardHeader>
        <CardTitle className="text-base">Receivables</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : error || !data ? (
          <QueryError thing="receivables" onRetry={() => refetch()} />
        ) : data.clients.length === 0 ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="text-receivables-empty"
          >
            No outstanding receivables across your clients.
          </p>
        ) : (
          <>
            <ScrollRegion label="Receivables by client table">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th scope="col" className="py-2 font-medium">
                      Client
                    </th>
                    <th scope="col" className="py-2 font-medium text-right">
                      Outstanding
                    </th>
                    <th scope="col" className="py-2 font-medium text-right">
                      Invoices
                    </th>
                    <th scope="col" className="py-2 font-medium text-right">
                      90+ days
                    </th>
                    <th scope="col" className="py-2 font-medium text-right">
                      Oldest due
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.clients.map((c) => (
                    <tr
                      key={`${c.clientPartyId}-${c.currency}`}
                      className="border-b last:border-0"
                      data-testid={`row-receivable-${c.clientPartyId}-${c.currency}`}
                    >
                      <td className="py-2.5 font-medium">
                        <Link
                          href={`/clients/${c.clientPartyId}`}
                          className="hover:underline rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        >
                          {c.clientName}
                        </Link>
                      </td>
                      <td className="py-2.5 text-right tabular-nums">
                        {formatMoney(c.outstandingTotal, c.currency)}
                      </td>
                      <td className="py-2.5 text-right tabular-nums">
                        {c.invoiceCount}
                      </td>
                      <td className="py-2.5 text-right tabular-nums">
                        {Number(c.overdue90Amount) > 0 ? (
                          <span className="font-medium text-red-500 dark:text-red-400">
                            {formatMoney(c.overdue90Amount, c.currency)}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="py-2.5 text-right text-muted-foreground tabular-nums">
                        {formatDate(c.oldestDueDate)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollRegion>
            {data.topDebtors.length > 0 && (
              <div className="mt-6">
                <h3 className="text-sm font-medium text-muted-foreground mb-2">
                  Top debtors
                </h3>
                <div className="divide-y">
                  {data.topDebtors.map((d) => (
                    <div
                      key={`${d.buyerPartyId}-${d.currency}`}
                      className="flex items-center justify-between gap-4 py-2"
                      data-testid={`row-debtor-${d.buyerPartyId}-${d.currency}`}
                    >
                      <p className="text-sm font-medium truncate">
                        {d.buyerName}
                      </p>
                      <p className="text-sm text-muted-foreground shrink-0 tabular-nums">
                        {formatMoney(d.outstanding, d.currency)} ·{" "}
                        {d.invoiceCount} invoice
                        {d.invoiceCount === 1 ? "" : "s"}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
