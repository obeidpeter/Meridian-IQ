import { Link } from "wouter";
import type { BuyerInvoice } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckCircle2 } from "lucide-react";
import { confirmationLabel } from "@/lib/format";
import { responseRecordedCopy, type ResponseState } from "@/lib/respond";
import type { InvoiceRespondState } from "./use-invoice-respond";

// Post-action confirmation: the response this visit just recorded, stated
// in full — what happened and what happens next. Takes the recorded
// response itself (non-null by the time it renders) plus the page bag.
export function ResponseRecordedCard({
  submitted,
  state,
}: {
  submitted: ResponseState;
  state: InvoiceRespondState;
}) {
  const { isFetching, checkForNewRequest } = state;
  return (
    <Card data-testid="card-response-recorded">
      <CardContent className="py-10 flex flex-col items-center text-center gap-2">
        <CheckCircle2
          className="w-10 h-10 text-emerald-600 dark:text-emerald-400"
          aria-hidden="true"
        />
        <p className="font-semibold" data-testid="text-response-recorded">
          {responseRecordedCopy(submitted).title}
        </p>
        <p className="text-sm text-muted-foreground max-w-md">
          {responseRecordedCopy(submitted).description}
        </p>
        {submitted === "queried" && (
          <Button
            className="mt-2"
            variant="outline"
            disabled={isFetching}
            onClick={() => void checkForNewRequest()}
          >
            {isFetching
              ? "Checking for a new request..."
              : "Check for a new request"}
          </Button>
        )}
        <Button
          asChild
          variant="outline"
          className="mt-2"
          data-testid="button-recorded-back"
        >
          <Link href="/confirmations">Back to confirmations</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

export function NoRequestCard({
  invoice,
  state,
}: {
  invoice: BuyerInvoice;
  state: InvoiceRespondState;
}) {
  const { isFetching, checkForNewRequest } = state;
  return (
    <Card data-testid="card-no-request">
      <CardContent className="pt-6">
        <p className="text-sm text-muted-foreground">
          {invoice.confirmationState === "none"
            ? "No confirmation has been requested for this invoice yet. The response form appears here once the supplier requests one."
            : `You have already responded to this invoice (${confirmationLabel(invoice.confirmationState).toLowerCase()}).`}
        </p>
        {invoice.confirmationState === "queried" && (
          <>
            <p className="mt-2 text-sm text-muted-foreground">
              Ask the supplier to clarify and send a new confirmation request.
              Your earlier response remains in the history.
            </p>
            <Button
              className="mt-3"
              variant="outline"
              disabled={isFetching}
              onClick={() => void checkForNewRequest()}
            >
              {isFetching
                ? "Checking for a new request..."
                : "Check for a new request"}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
