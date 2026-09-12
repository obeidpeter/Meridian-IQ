// The invoice detail page's header row (R126 moved it out of the page
// shell): the title block (number, status badge, dates, WHT category, the
// stamping help link) and the action row (pin, submit/retry, edit, PDF,
// credit note, cancel, new-from). Both read the narrowed invoice; the
// actions also read the shell's state bag and abilities.
import { Link } from "wouter";
import { getGetInvoicePdfUrl, type Invoice } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { invoicePdfFilename, triggerDownload } from "@/lib/download";
import { Ban, Download, FilePlus, Pin, Undo2, Wrench } from "lucide-react";
import { whtCategoryLabel } from "@workspace/format/wht-copy";
import { formatDate, statusLabel, badgeClasses } from "@/lib/format";
import type { InvoiceAbilities } from "./abilities";
import type { InvoiceDetailState } from "./use-invoice-detail";

export function DetailHeader({ invoice }: { invoice: Invoice }) {
  return (
    <div className="min-w-0 [overflow-wrap:anywhere]">
      <div className="flex items-center gap-2 flex-wrap">
        <h1
          className="text-2xl md:text-3xl font-bold"
          data-testid="text-page-title"
        >
          {invoice.invoiceNumber}
        </h1>
        <span className={badgeClasses(invoice.status)}>
          {statusLabel(invoice.status)}
        </span>
      </div>
      <p className="text-muted-foreground mt-1">
        Issued {formatDate(invoice.issueDate)} · Due{" "}
        {formatDate(invoice.dueDate)}
      </p>
      {/* WHT Desk: shown only when a human assigned a category — the
          label wording comes from the shared wht-copy catalogue. */}
      {invoice.whtCategory && (
        <p
          className="text-sm text-muted-foreground mt-1"
          data-testid="text-invoice-wht-category"
        >
          WHT category: {whtCategoryLabel(invoice.whtCategory)}
        </p>
      )}
      <p className="mt-1 text-xs text-muted-foreground">
        <Link
          href="/help#stamping"
          className="font-bold text-teal-800 underline underline-offset-2 dark:text-teal-300"
          data-testid="link-help-stamping"
        >
          What does stamping mean?
        </Link>
      </p>
    </div>
  );
}

export function DetailActions({
  state,
  invoice,
  abilities,
}: {
  state: InvoiceDetailState;
  invoice: Invoice;
  abilities: InvoiceAbilities;
}) {
  const {
    id,
    pinnedInvoices,
    fix,
    openFix,
    setAdjustKind,
    handleNewFromInvoice,
  } = state;
  const { canCredit, canCancel } = abilities;
  return (
    <div className="flex max-w-full flex-wrap gap-2 [&_button]:h-auto [&_button]:min-h-9 [&_button]:max-w-full [&_button]:whitespace-normal [&_button]:py-2">
      <Button
        type="button"
        variant="outline"
        aria-pressed={pinnedInvoices.isPinned(id)}
        onClick={() =>
          pinnedInvoices.toggle({
            id,
            label: invoice.invoiceNumber,
            detail: statusLabel(invoice.status),
          })
        }
        data-testid="button-pin-invoice"
      >
        <Pin
          className={`w-4 h-4 mr-2 ${pinnedInvoices.isPinned(id) ? "fill-current" : ""}`}
          aria-hidden="true"
        />
        {pinnedInvoices.isPinned(id) ? "Pinned" : "Pin"}
      </Button>
      {abilities.canEdit &&
        (invoice.status === "draft" || invoice.status === "validated") &&
        !fix && (
          <Button
            variant="outline"
            onClick={openFix}
            data-testid="button-edit-invoice"
          >
            <Wrench className="w-4 h-4 mr-2" aria-hidden="true" /> Edit invoice
          </Button>
        )}
      {/* Every invoice has a PDF — the server watermarks unstamped ones —
          so the button is always offered. Same idiom as the vault's CSV
          export: a plain same-origin navigation, auth on the session
          cookie, but via a named-download anchor so the file saves as
          invoice-<number>.pdf. */}
      <Button
        variant="outline"
        onClick={() =>
          triggerDownload(
            getGetInvoicePdfUrl(id),
            invoicePdfFilename(invoice.invoiceNumber),
          )
        }
        data-testid="button-download-pdf"
      >
        <Download className="w-4 h-4 mr-2" aria-hidden="true" /> Download PDF
      </Button>
      {canCredit && (
        <Button
          variant="outline"
          onClick={() => setAdjustKind("credit")}
          data-testid="button-credit-note"
        >
          <Undo2 className="w-4 h-4 mr-2" aria-hidden="true" /> Issue credit
          note
        </Button>
      )}
      {canCancel && (
        <Button
          variant="outline"
          className="text-destructive hover:text-destructive dark:text-red-300 dark:hover:text-red-200"
          onClick={() => setAdjustKind("cancel")}
          data-testid="button-cancel-invoice"
        >
          <Ban className="w-4 h-4 mr-2" aria-hidden="true" /> Cancel invoice
        </Button>
      )}
      <Button
        variant="outline"
        onClick={handleNewFromInvoice}
        disabled={!abilities.canWrite}
        data-testid="button-new-from-invoice"
      >
        <FilePlus className="w-4 h-4 mr-2" aria-hidden="true" /> New from this
        invoice
      </Button>
    </div>
  );
}
