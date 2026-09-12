import { ArrowRight, Send, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Invoice } from "@workspace/api-client-react";
import type { InvoiceAbilities } from "./abilities";
import type { InvoiceDetailState } from "./use-invoice-detail";
import type { InvoiceTab } from "./workspace-tabs";

function needsInvoiceCorrection(invoice: Invoice, state: InvoiceDetailState) {
  return (
    state.validationErrors.length > 0 ||
    (invoice.status === "failed" && state.catalogue?.retriable === false)
  );
}

export function NextAction({
  state,
  invoice,
  abilities,
  onTabChange,
}: {
  state: InvoiceDetailState;
  invoice: Invoice;
  abilities: InvoiceAbilities;
  onTabChange: (tab: InvoiceTab) => void;
}) {
  const busy =
    state.validate.isPending ||
    state.submit.isPending ||
    state.updateInvoice.isPending;
  const needsFix = abilities.canEdit && needsInvoiceCorrection(invoice, state);
  const submit = () => {
    onTabChange("overview");
    state.setConfirmSubmit(true);
  };
  let label = "View documents";
  let description = unavailableActionDescription(invoice.status);
  let action = () => onTabChange("documents");
  let disabled = false;
  let Icon = ArrowRight;
  if (abilities.canSubmit) {
    Icon = Send;
    action = submit;
    disabled = busy;
    label = busy
      ? "Submitting..."
      : invoice.status === "failed"
        ? "Retry transmission"
        : "Submit for stamping";
    description =
      "Review the invoice before transmission. Required independent approval is checked on submission; submission is not an official stamp.";
    if (state.fix || needsFix) {
      Icon = Wrench;
      label = state.fix ? "Review changes" : "Review and fix invoice";
      description = state.fix
        ? "Unsaved edits are open. Review or discard them before submitting the saved invoice."
        : "Resolve the validation or rejection issues before another transmission.";
      action = () => {
        onTabChange("overview");
        if (!state.fix) state.openFix();
      };
    }
  } else if (invoice.status === "submitted") {
    label = "View submission history";
    description =
      "Awaiting the e-invoicing service. No official stamp is confirmed yet; another submission is unavailable while this one is pending.";
    action = () => onTabChange("history");
  } else if (abilities.canRequestConfirmation) {
    label = state.createConfirmation.isPending
      ? "Requesting..."
      : "Request confirmation";
    description =
      "Request the buyer's acknowledgement of this stamped invoice. Buyer confirmation does not record a payment.";
    action = state.handleRequestConfirmation;
    disabled = state.createConfirmation.isPending;
    Icon = Send;
  } else if (["stamped", "confirmed", "settled"].includes(invoice.status)) {
    label = "View recorded payments";
    description =
      "Payment records are separate from stamp records and buyer confirmation.";
    action = () => onTabChange("payments");
  }
  return (
    <section
      aria-label="Next action"
      className="flex flex-col gap-4 border-y bg-muted/30 px-4 py-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="min-w-0 space-y-1">
        <h2 className="text-sm font-semibold">Next action</h2>
        <p
          className="max-w-2xl text-sm text-muted-foreground"
          id="invoice-next-action-description"
        >
          {description}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2 sm:max-w-xs">
        <Button
          type="button"
          onClick={action}
          disabled={disabled}
          aria-describedby="invoice-next-action-description"
          data-testid="button-next-action"
          className="h-auto min-h-11 max-w-full whitespace-normal py-2 text-left"
        >
          <Icon className="mr-2 size-4 shrink-0" aria-hidden="true" />
          {label}
        </Button>
        {needsFix && !state.fix && invoice.status === "failed" && (
          <Button
            type="button"
            variant="outline"
            onClick={submit}
            disabled={busy}
            className="h-auto min-h-11 whitespace-normal py-2"
          >
            <Send className="mr-2 size-4 shrink-0" aria-hidden="true" />
            Retry transmission
          </Button>
        )}
      </div>
    </section>
  );
}

function unavailableActionDescription(status: Invoice["status"]) {
  return ["draft", "validated", "failed"].includes(status)
    ? "Submission is not available for this account. You can still review the invoice documents and history."
    : "This invoice is closed. Its documents and history remain available.";
}
