import type { ReactNode } from "react";
import { getGetInvoicePdfUrl, type Invoice } from "@workspace/api-client-react";
import { Download, FileText } from "lucide-react";
import { InvoiceRoomCard } from "@/components/invoice-room-card";
import { EvidenceWorkspace } from "@/pages/evidence";
import {
  ApprovalsCard,
  canApproveInvoice,
} from "@/components/invoice-approvals";
import { Button } from "@/components/ui/button";
import { QueryError } from "@/components/query-error";
import { invoicePdfFilename, triggerDownload } from "@/lib/download";
import {
  EscalationsCard,
  SettlementsCard,
  SubmissionTimeline,
} from "./history-cards";
import { ConfirmationCard } from "./confirmation-card";
import { PaymentReminderCard } from "./payment-reminder-card";
import { StampCard } from "./status-section";
import type { InvoiceAbilities } from "./abilities";
import type { InvoiceDetailState } from "./use-invoice-detail";

type PanelProps = {
  state: InvoiceDetailState;
  invoice: Invoice;
  abilities: InvoiceAbilities;
};

function ReadState({
  query,
  thing,
  empty,
  children,
}: {
  query: { isError?: boolean; isPending?: boolean; refetch: () => unknown };
  thing: string;
  empty: string;
  children: ReactNode;
}) {
  if (query.isError)
    return <QueryError thing={thing} onRetry={() => void query.refetch()} />;
  if (query.isPending)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading {thing}...
      </p>
    );
  return (
    children || <p className="py-4 text-sm text-muted-foreground">{empty}</p>
  );
}

export function DocumentsPanel({ state, invoice }: PanelProps) {
  return (
    <>
      <section
        aria-label="Invoice PDF"
        className="flex flex-wrap items-center justify-between gap-4 border-b pb-5"
      >
        <div className="min-w-0 space-y-1">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <FileText className="size-4 shrink-0" aria-hidden="true" />
            Invoice PDF
          </h2>
          <p className="text-sm text-muted-foreground">
            Unstamped PDFs carry a watermark. A PDF download does not submit or
            stamp the invoice.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() =>
            triggerDownload(
              getGetInvoicePdfUrl(state.id),
              invoicePdfFilename(invoice.invoiceNumber),
            )
          }
        >
          <Download className="mr-2 size-4 shrink-0" aria-hidden="true" />
          Download invoice PDF
        </Button>
      </section>
      <section aria-label="Stamp record" className="space-y-3">
        <h2 className="text-base font-semibold">Stamp record</h2>
        {state.stampedFamily ? (
          <ReadState
            query={state.stampQuery}
            thing="the stamp record"
            empty="The invoice status indicates stamping, but the stamp record is not available yet."
          >
            {state.stamp && <StampCard stamp={state.stamp} />}
          </ReadState>
        ) : (
          <p className="text-sm text-muted-foreground">
            No stamp record is verified for this invoice. Internal approval and
            submission do not establish live production stamping.
          </p>
        )}
      </section>
      {state.me?.features.includes("invoice_room") && state.stampedFamily && (
        <InvoiceRoomCard
          invoiceId={state.id}
          invoiceNumber={invoice.invoiceNumber}
          buyerName={state.buyer?.legalName ?? "Buyer"}
        />
      )}
      <EvidenceWorkspace
        invoiceId={state.id}
        client={{
          id: invoice.supplierPartyId,
          label: state.me?.workspaceName ?? "Invoice supplier",
        }}
        embedded
      />
    </>
  );
}

export function ApprovalsPanel({ state, invoice, abilities }: PanelProps) {
  const { approvalsQuery } = state;
  return (
    <>
      <section aria-label="Internal submission approval" className="space-y-3">
        <h2 className="text-base font-semibold">
          Internal submission approval
        </h2>
        <p className="text-sm text-muted-foreground">
          Approval applies to an invoice version. Where independent approval is
          required, the approver and submitter must be different people. It is
          not buyer confirmation or an official stamp.
        </p>
        <ApprovalsCard
          invoiceId={state.id}
          role={state.me?.role}
          status={invoice.status}
          contentRevision={invoice.contentRevision}
        />
        {approvalsQuery.isSuccess &&
          approvalsQuery.data?.length === 0 &&
          !canApproveInvoice(state.me?.role, invoice.status) && (
            <p className="text-sm text-muted-foreground">
              No internal approvals recorded. Approval is available to firm
              staff on draft, validated or failed invoices.
            </p>
          )}
      </section>
      <section aria-label="Buyer acknowledgement" className="space-y-3">
        <h2 className="text-base font-semibold">Buyer acknowledgement</h2>
        {abilities.confirmationsDark ? (
          <ConfirmationCard
            invoice={invoice}
            timeline={[]}
            featureDisabled
            canRequest={false}
            onRequest={state.handleRequestConfirmation}
            isPending={false}
          />
        ) : (
          <ReadState
            query={state.confirmationsQuery}
            thing="buyer confirmations"
            empty="Buyer confirmation records are not available."
          >
            {state.confirmations !== undefined && (
              <ConfirmationCard
                invoice={invoice}
                timeline={abilities.confirmationTimeline}
                featureDisabled={false}
                canRequest={abilities.canRequestConfirmation}
                onRequest={state.handleRequestConfirmation}
                isPending={state.createConfirmation.isPending}
              />
            )}
          </ReadState>
        )}
      </section>
    </>
  );
}

export function PaymentsPanel({ state, invoice, abilities }: PanelProps) {
  return (
    <>
      <section aria-label="Recorded payments" className="space-y-3">
        <h2 className="text-base font-semibold">Recorded payments</h2>
        <p className="text-sm text-muted-foreground">
          These are recorded settlement events, not a bank balance. A stamp,
          internal approval or buyer acknowledgement is not evidence of payment.
        </p>
        <ReadState
          query={state.settlementsQuery}
          thing="recorded payments"
          empty="No payment events recorded for this invoice."
        >
          {!!state.settlements?.length && (
            <SettlementsCard settlements={state.settlements} />
          )}
        </ReadState>
      </section>
      {abilities.canClerkExplain &&
        invoice.kind === "invoice" &&
        ["submitted", "stamped", "confirmed"].includes(invoice.status) && (
          <PaymentReminderCard invoice={invoice} />
        )}
    </>
  );
}

export function HistoryPanel({ state }: PanelProps) {
  return (
    <>
      <section aria-label="Submission history" className="space-y-3">
        <h2 className="text-base font-semibold">Submission history</h2>
        <ReadState
          query={state.attemptsQuery}
          thing="submission history"
          empty="No submission attempts recorded."
        >
          {!!state.attempts?.length && (
            <SubmissionTimeline attempts={state.attempts} />
          )}
        </ReadState>
      </section>
      <section aria-label="Escalation history" className="space-y-3">
        <h2 className="text-base font-semibold">Escalation history</h2>
        <ReadState
          query={state.escalationsQuery}
          thing="escalation history"
          empty="No escalations recorded."
        >
          {!!state.escalations?.length && (
            <EscalationsCard escalations={state.escalations} />
          )}
        </ReadState>
      </section>
    </>
  );
}
