// The invoice detail page's two confirm gates (R126 moved them out of the
// page shell): the stamping-submission review and the stored-draft
// replacement guard behind "New from this invoice". The confirm actions
// call the shell's state setters and handlers directly, so the dialogs'
// focus and dismiss semantics are the shadcn defaults as before.
import type { Invoice } from "@workspace/api-client-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { formatAmount } from "@/lib/format";
import type { InvoiceDetailState } from "./use-invoice-detail";

export function SubmitConfirmDialog({
  state,
  invoice,
}: {
  state: InvoiceDetailState;
  invoice: Invoice;
}) {
  const { confirmSubmit, setConfirmSubmit, buyer, handleSubmit } = state;
  return (
    <AlertDialog open={confirmSubmit} onOpenChange={setConfirmSubmit}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Review before submitting</AlertDialogTitle>
          <AlertDialogDescription>
            Check the customer and tax totals before sending this invoice to
            your configured e-invoicing service.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <dl className="divide-y rounded-md border bg-muted/25 px-3 text-sm [&_dd]:min-w-0 [&_dd]:[overflow-wrap:anywhere]">
          <div className="flex justify-between gap-4 py-2.5">
            <dt className="text-muted-foreground">Invoice</dt>
            <dd className="text-right font-medium">{invoice.invoiceNumber}</dd>
          </div>
          <div className="flex justify-between gap-4 py-2.5">
            <dt className="text-muted-foreground">Customer</dt>
            <dd className="max-w-[65%] text-right font-medium">
              {buyer?.legalName ?? `Party ${invoice.buyerPartyId.slice(0, 8)}`}
            </dd>
          </div>
          <div className="flex justify-between gap-4 py-2.5">
            <dt className="text-muted-foreground">Invoice total</dt>
            <dd className="text-right font-medium tabular-nums">
              {formatAmount(invoice.grandTotal, invoice.currency)}
            </dd>
          </div>
          <div className="flex justify-between gap-4 py-2.5">
            <dt className="text-muted-foreground">VAT included</dt>
            <dd className="text-right font-medium tabular-nums">
              {formatAmount(invoice.vatTotal, invoice.currency)}
            </dd>
          </div>
        </dl>
        <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
          Once the e-invoicing service accepts and stamps this invoice, you must
          use a cancellation or credit note to correct it. Do not submit while
          the customer, amount, currency, or VAT is still being checked.
        </p>
        <AlertDialogFooter>
          <AlertDialogCancel>Go back and review</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              setConfirmSubmit(false);
              void handleSubmit();
            }}
            data-testid="button-confirm-submit"
          >
            Confirm and submit
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function NewFromDraftDialog({
  state,
  invoice,
}: {
  state: InvoiceDetailState;
  invoice: Invoice;
}) {
  const { confirmNewFrom, setConfirmNewFrom, startNewFromInvoice } = state;
  return (
    <AlertDialog open={confirmNewFrom} onOpenChange={setConfirmNewFrom}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Replace your saved draft?</AlertDialogTitle>
          <AlertDialogDescription>
            You already have an unfinished invoice draft. Starting a new invoice
            from {invoice.invoiceNumber} replaces that draft — this cannot be
            undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep my draft</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              setConfirmNewFrom(false);
              startNewFromInvoice();
            }}
            data-testid="button-confirm-new-from-invoice"
          >
            Replace draft
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
