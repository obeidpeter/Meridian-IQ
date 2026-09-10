// The buyer invoice response page (R126 split the 718-line page into this
// shell, the state hook, the layout pieces and one module per card). The
// route (App.tsx) keeps importing "@/pages/invoice-respond": this module is
// the page's surface.

import { isFeatureDisabled } from "@/lib/errors";
import {
  formatDate,
  confirmationLabel,
  confirmationBadgeClasses,
} from "@/lib/format";
import { FeatureUnavailable } from "@/components/feature-unavailable";
import { QueryError } from "@/components/query-error";
import { useInvoiceRespond } from "./use-invoice-respond";
import { BackLink, RespondSkeleton, UnknownInvoiceCard } from "./layout";
import { InvoiceDetailsCard } from "./invoice-details-card";
import { NoRequestCard, ResponseRecordedCard } from "./outcome-cards";
import { ResponseForm } from "./response-form";
import { PaymentFlagsCard } from "./payment-flags-card";

export function InvoiceRespond() {
  const state = useInvoiceRespond();
  const { invoice, isLoading, error, refetch, submitted } = state;

  if (isLoading) return <RespondSkeleton />;

  if (error) {
    return (
      <div className="space-y-4">
        <BackLink />
        {isFeatureDisabled(error) ? (
          <FeatureUnavailable feature="Buyer Rails" />
        ) : (
          <QueryError thing="this invoice" onRetry={() => refetch()} />
        )}
      </div>
    );
  }

  if (!invoice) return <UnknownInvoiceCard />;

  const awaitingResponse = invoice.confirmationState === "requested";

  return (
    <div className="space-y-6">
      <BackLink />

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1
            className="text-2xl md:text-3xl font-bold"
            data-testid="text-page-title"
          >
            <span data-testid="text-invoice-number">
              {invoice.invoiceNumber}
            </span>
          </h1>
          <p className="text-muted-foreground mt-1">
            {invoice.supplierName} · issued {formatDate(invoice.issueDate)}
          </p>
        </div>
        <span
          className={confirmationBadgeClasses(invoice.confirmationState)}
          data-testid="badge-confirmation-state"
        >
          {confirmationLabel(invoice.confirmationState)}
        </span>
      </div>

      <InvoiceDetailsCard invoice={invoice} />

      {submitted !== null ? (
        // Post-action confirmation: the response this visit just recorded,
        // stated in full — what happened and what happens next.
        <ResponseRecordedCard submitted={submitted} state={state} />
      ) : awaitingResponse ? (
        <ResponseForm invoice={invoice} state={state} />
      ) : (
        <NoRequestCard invoice={invoice} state={state} />
      )}

      <PaymentFlagsCard invoice={invoice} state={state} />
    </div>
  );
}
