import type {
  ClientRisk,
  ComplianceDeadline,
  ConsoleInvoice,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InvoiceStatusLight } from "@/components/status-light";
import { CalendarClock, FileText } from "lucide-react";
import {
  formatNaira,
  formatDate,
  badgeClasses,
  statusLabel,
  severityBadgeClasses,
  humanize,
} from "@/lib/format";

// The Today and Invoices views' invoice table.
export function ClientInvoicesCard({
  client,
  invoices,
}: {
  client: ClientRisk;
  invoices: ConsoleInvoice[];
}) {
  const failingIds = new Set(client.failingInvoiceIds);
  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle className="flex items-center gap-2.5">
          <span className="mi-card-icon">
            <FileText aria-hidden="true" />
          </span>
          Invoices
        </CardTitle>
      </CardHeader>
      <CardContent className="px-0 sm:px-6">
        {invoices.length === 0 ? (
          <p className="px-6 text-sm text-muted-foreground sm:px-0">
            No invoices yet.
          </p>
        ) : (
          <div className="overflow-x-auto sm:rounded-[var(--mi-radius)] sm:border sm:border-border">
            <table className="w-full min-w-[40rem] border-collapse text-left text-sm">
              <thead className="bg-muted/50 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Invoice</th>
                  <th className="px-3 py-2">Buyer</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">
                    <span className="sr-only">Rail status</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {invoices.map((inv) => {
                  const failing = inv.failing || failingIds.has(inv.id);
                  return (
                    <tr
                      key={inv.id}
                      data-testid={`row-invoice-${inv.id}`}
                      className={failing ? "bg-destructive/5" : ""}
                    >
                      <td className="px-3 py-2.5">
                        <p className="font-medium">{inv.invoiceNumber}</p>
                        {failing && (
                          <span
                            className="text-[11px] font-bold text-destructive"
                            data-testid={`flag-failing-${inv.id}`}
                          >
                            NEEDS ACTION
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <p className="max-w-56 truncate">{inv.buyerName}</p>
                        <p className="text-xs text-muted-foreground">
                          {inv.category} · {formatDate(inv.issueDate)}
                        </p>
                      </td>
                      <td className="px-3 py-2.5 text-right font-medium tabular-nums">
                        {formatNaira(inv.grandTotal)}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className={badgeClasses(inv.status)}>
                          {statusLabel(inv.status)}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        <InvoiceStatusLight
                          invoiceId={inv.id}
                          showWhy={failing}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// The Today view's deadlines card.
export function ClientDeadlinesCard({
  deadlines,
}: {
  deadlines: ComplianceDeadline[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2.5">
          <span className="mi-card-icon">
            <CalendarClock aria-hidden="true" />
          </span>
          Deadlines
        </CardTitle>
      </CardHeader>
      <CardContent>
        {deadlines.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No upcoming deadlines.
          </p>
        ) : (
          <div className="space-y-3">
            {deadlines.map((d) => (
              <div
                key={d.id}
                data-testid={`row-deadline-${d.id}`}
                className="border rounded-md p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="font-medium text-sm">{d.title}</p>
                  <span className={severityBadgeClasses(d.severity)}>
                    {humanize(d.status)}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Due {formatDate(d.dueDate)}
                </p>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
