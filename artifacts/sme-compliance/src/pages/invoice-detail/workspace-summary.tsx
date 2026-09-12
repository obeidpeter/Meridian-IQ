import type { Invoice } from "@workspace/api-client-react";
import { formatAmount } from "@/lib/format";
import type { InvoiceDetailState } from "./use-invoice-detail";
import { stampEvidence } from "./stamp-evidence";

function submissionStage(status: Invoice["status"]) {
  switch (status) {
    case "draft":
    case "validated":
      return "Not submitted";
    case "submitted":
      return "Awaiting service response";
    case "failed":
      return "Transmission failed";
    case "stamped":
    case "confirmed":
    case "settled":
    case "credited":
      return "Accepted for stamping";
    default:
      return "Closed";
  }
}

export function WorkspaceSummary({
  state,
  invoice,
}: {
  state: InvoiceDetailState;
  invoice: Invoice;
}) {
  const approvals = state.approvalsQuery;
  const currentApprovals = approvals.data?.filter(
    (approval) =>
      !approval.revokedAt &&
      approval.contentRevision === invoice.contentRevision,
  );
  const approvalLabel = approvals.isError
    ? "Unavailable"
    : approvals.isPending
      ? "Loading..."
      : currentApprovals === undefined
        ? "Not available"
        : currentApprovals.length > 0
          ? `${currentApprovals.length} current-version approval(s)`
          : "No current-version approval";
  const payments = state.settlementsQuery;
  const paymentLabel = payments.isError
    ? "Unavailable"
    : payments.isPending
      ? "Loading..."
      : payments.data === undefined
        ? "Not available"
        : `${payments.data.length} recorded event(s)`;
  return (
    <section aria-label="Invoice overview" className="space-y-4 border-b pb-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold [overflow-wrap:anywhere]">
            {state.buyer?.legalName ?? `Customer ${invoice.buyerPartyId}`}
          </h2>
          <p className="text-sm text-muted-foreground">
            Version {invoice.contentRevision}
          </p>
        </div>
        <p className="shrink-0 text-xl font-semibold tabular-nums sm:max-w-[50%] sm:text-right [overflow-wrap:anywhere]">
          {formatAmount(invoice.grandTotal, invoice.currency)}
        </p>
      </div>
      <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2 xl:grid-cols-4">
        <div>
          <dt className="text-muted-foreground">Internal approval</dt>
          <dd className="mt-1 font-medium">{approvalLabel}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Submission</dt>
          <dd className="mt-1 font-medium">
            {submissionStage(invoice.status)}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Stamp record</dt>
          <dd className="mt-1 font-medium">
            {state.stampedFamily
              ? state.stampQuery.isError
                ? "Unable to verify stamp"
                : state.stamp
                  ? stampEvidence(state.stamp).label
                  : "Stamp record not yet available"
              : "No stamp verified"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Recorded payments</dt>
          <dd className="mt-1 font-medium">{paymentLabel}</dd>
        </div>
      </dl>
      {invoice.notes && (
        <p className="whitespace-pre-wrap text-sm text-muted-foreground [overflow-wrap:anywhere]">
          {invoice.notes}
        </p>
      )}
    </section>
  );
}
