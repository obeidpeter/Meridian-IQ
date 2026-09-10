// The invoice detail page's trail (R126 moved it out of the page shell):
// the buyer confirmation, the invoice room, settlements, the submission
// timeline and escalations, in the shell's original order.
import type { Invoice } from "@workspace/api-client-react";
import { InvoiceRoomCard } from "@/components/invoice-room-card";
import {
  EscalationsCard,
  SettlementsCard,
  SubmissionTimeline,
} from "./history-cards";
import { ConfirmationCard } from "./confirmation-card";
import type { InvoiceAbilities } from "./abilities";
import type { InvoiceDetailState } from "./use-invoice-detail";

export function TrailSection({
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
    me,
    stampedFamily,
    buyer,
    settlements,
    attempts,
    escalations,
    handleRequestConfirmation,
    createConfirmation,
  } = state;
  const { confirmationTimeline, confirmationsDark, canRequestConfirmation } =
    abilities;
  return (
    <>
      <ConfirmationCard
        invoice={invoice}
        timeline={confirmationTimeline}
        featureDisabled={confirmationsDark}
        canRequest={canRequestConfirmation}
        onRequest={handleRequestConfirmation}
        isPending={createConfirmation.isPending}
      />

      {me?.features.includes("invoice_room") && stampedFamily && (
        <InvoiceRoomCard
          invoiceId={id}
          invoiceNumber={invoice.invoiceNumber}
          buyerName={buyer?.legalName ?? "Buyer"}
        />
      )}

      {settlements && settlements.length > 0 && (
        <SettlementsCard settlements={settlements} />
      )}

      {attempts && attempts.length > 0 && (
        <SubmissionTimeline attempts={attempts} />
      )}

      {escalations && escalations.length > 0 && (
        <EscalationsCard escalations={escalations} />
      )}
    </>
  );
}
