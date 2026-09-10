import type { BuyerInvoice } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  formatNaira,
  formatDate,
  badgeClasses,
  statusLabel,
  stampBadge,
  eligibleBadge,
} from "@/lib/format";

export function InvoiceDetailsCard({ invoice }: { invoice: BuyerInvoice }) {
  const stamp = stampBadge(invoice.stampValid);
  const eligible = eligibleBadge(invoice.eligible);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Invoice details</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <p className="text-muted-foreground">Amount</p>
            <p
              className="font-medium tabular-nums"
              data-testid="text-grand-total"
            >
              {formatNaira(invoice.grandTotal)}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">VAT</p>
            <p className="font-medium tabular-nums">
              {formatNaira(invoice.vatTotal)}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">Due date</p>
            <p className="font-medium">{formatDate(invoice.dueDate)}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Status</p>
            <span className={badgeClasses(invoice.status)}>
              {statusLabel(invoice.status)}
            </span>
          </div>
        </div>
        <div className="mt-4 pt-4 border-t flex flex-wrap gap-2">
          <span className={stamp.classes} data-testid="badge-stamp">
            {stamp.label}
          </span>
          <span className={eligible.classes} data-testid="badge-eligible">
            {eligible.label}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
