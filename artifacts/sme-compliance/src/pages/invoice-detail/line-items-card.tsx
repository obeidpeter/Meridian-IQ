// The invoice detail page's line-items card (R126 moved it out of the page
// shell): every line with its extension and VAT, the grand total, and the
// naira equivalent for a foreign-currency invoice at its captured rate.
import type {
  Invoice,
  InvoiceDetail as InvoiceDetailData,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { nairaApproxLine } from "@/pages/invoices";
import { formatAmount, formatPct } from "@/lib/format";

export function LineItemsCard({
  invoice,
  data,
}: {
  invoice: Invoice;
  data: InvoiceDetailData | undefined;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Line items</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {data?.lines.map((l) => (
          <div
            key={l.id}
            className="flex justify-between text-sm border-b last:border-0 py-2"
          >
            <div>
              <p className="font-medium">{l.description}</p>
              <p className="text-muted-foreground text-xs">
                {l.quantity} × {formatAmount(l.unitPrice, invoice.currency)} ·
                VAT {formatPct(l.vatRate)}
              </p>
            </div>
            <span className="font-medium tabular-nums">
              {formatAmount(
                Number(l.lineExtension) + Number(l.vatAmount),
                invoice.currency,
              )}
            </span>
          </div>
        ))}
        <div className="flex justify-between pt-2 font-semibold">
          <span>Total</span>
          <span className="tabular-nums">
            {formatAmount(invoice.grandTotal, invoice.currency)}
          </span>
        </div>
        {nairaApproxLine(invoice) && (
          <p
            className="text-right text-xs text-muted-foreground tabular-nums"
            data-testid="text-total-ngn-equivalent"
          >
            {nairaApproxLine(invoice)} at the rate captured when this invoice
            was issued (₦
            {Number(invoice.fxRateToNgn).toLocaleString("en-NG", {
              maximumFractionDigits: 4,
            })}{" "}
            per {invoice.currency})
          </p>
        )}
      </CardContent>
    </Card>
  );
}
