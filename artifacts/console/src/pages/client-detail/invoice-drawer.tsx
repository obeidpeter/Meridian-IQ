import { Download } from "lucide-react";
import {
  getGetInvoicePdfUrl,
  type InvoiceDetail,
} from "@workspace/api-client-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import {
  badgeClasses,
  formatAmount,
  formatDate,
  statusLabel,
} from "@/lib/format";
import { triggerDownload } from "@/lib/download";
import { EvidenceWorkspace } from "@/pages/evidence";

export function ClientInvoiceDrawer({
  detail,
  clientName,
  onClose,
  onCloseAutoFocus,
}: {
  detail: InvoiceDetail;
  clientName: string;
  onClose: () => void;
  onCloseAutoFocus: (event: Event) => void;
}) {
  const { invoice, lines } = detail;
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        side="right"
        className="w-full space-y-6 sm:max-w-2xl [overflow-wrap:anywhere] [&>button.absolute]:size-11"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <SheetHeader className="pr-8 text-left">
          <SheetTitle>{invoice.invoiceNumber}</SheetTitle>
          <SheetDescription>
            {clientName} · Version {invoice.contentRevision}
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className={badgeClasses(invoice.status)}>
            {statusLabel(invoice.status)}
          </span>
          <Button
            variant="outline"
            className="h-auto min-h-11 max-w-full whitespace-normal py-2"
            onClick={() =>
              triggerDownload(
                getGetInvoicePdfUrl(invoice.id),
                `invoice-${invoice.invoiceNumber.replace(/[^a-zA-Z0-9._-]+/g, "-") || invoice.id}.pdf`,
              )
            }
          >
            <Download className="mr-2 size-4 shrink-0" aria-hidden="true" />
            Download PDF
          </Button>
        </div>
        <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">Issued</dt>
            <dd>{formatDate(invoice.issueDate)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Due</dt>
            <dd>{formatDate(invoice.dueDate)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Invoice total</dt>
            <dd className="font-semibold tabular-nums">
              {formatAmount(invoice.grandTotal, invoice.currency)}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">VAT included</dt>
            <dd className="tabular-nums">
              {formatAmount(invoice.vatTotal, invoice.currency)}
            </dd>
          </div>
        </dl>
        <p className="border-y py-4 text-sm text-muted-foreground">
          Internal approval, submission, official stamping and recorded payments
          are separate records. The invoice status alone does not establish an
          independent approval or receipt of funds. Unstamped PDFs carry a
          watermark.
        </p>
        <section aria-label="Line items" className="space-y-3">
          <h2 className="text-base font-semibold">Line items</h2>
          {lines.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No line items recorded.
            </p>
          ) : (
            <ul className="divide-y">
              {lines.map((line) => (
                <li key={line.id} className="space-y-1 py-3 text-sm">
                  <p className="font-medium">{line.description}</p>
                  <p className="text-muted-foreground">
                    {line.quantity} ×{" "}
                    {formatAmount(line.unitPrice, invoice.currency)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
        {invoice.notes && (
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">
            {invoice.notes}
          </p>
        )}
        <EvidenceWorkspace
          invoiceId={invoice.id}
          client={{ id: invoice.supplierPartyId, label: clientName }}
          embedded
        />
      </SheetContent>
    </Sheet>
  );
}
