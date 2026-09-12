// What the loaded invoice allows (R126 moved it out of the page shell): the
// submit, cancel, credit-note and confirmation gates plus the failure focus
// fields. Pure — computed by the shell after its early returns, so the
// invoice is the narrowed record and `invoice.status` stays unguarded.
import type { Confirmation, Invoice, Me } from "@workspace/api-client-react";
import { isFeatureDisabled } from "@/lib/errors";
import { ERROR_FOCUS } from "@/lib/error-focus";

function allowsConfirmationRequest(
  status: Invoice["status"],
  latest: Confirmation | undefined,
) {
  return (
    status === "stamped" &&
    (!latest || (latest.state !== "requested" && latest.state !== "confirmed"))
  );
}

export function invoiceAbilities({
  invoice,
  me,
  errorCode,
  confirmations,
  confirmationsError,
}: {
  invoice: Invoice;
  me: Me | undefined;
  errorCode: string | undefined;
  confirmations: Confirmation[] | undefined;
  confirmationsError: unknown;
}) {
  // draft/validated submit for the first time; failed retries the transmission
  // (failed → submitted is a legal lifecycle transition — the fix-and-retry
  // flow below is for when the content itself needs correcting first).
  const capabilities = new Set(me?.capabilities ?? []);
  const canWrite = capabilities.has("invoice.write");
  const canSubmit =
    capabilities.has("invoice.submit") &&
    ["draft", "validated", "failed"].includes(invoice.status) &&
    (invoice.status !== "draft" || canWrite);
  const canEdit = canWrite && canSubmit;
  // Same capability the explain-failure route checks. The catalogue card
  // renders regardless; only Clerk's rephrasing needs the capability.
  const canClerkExplain = capabilities.has("clerk.capture");
  // Which fields the rail's error code implicates — those inputs get a
  // "flagged" pill so the user knows where to look first.
  const focus = ERROR_FOCUS[errorCode ?? ""] ?? [];
  // CORE-09: cancellation is allowed from any non-terminal, non-inflight state;
  // a credit note adjusts a stamped/confirmed/settled invoice. Mirrors the
  // server's lifecycle TRANSITIONS map — the server still has the final say.
  const canCancel =
    canWrite &&
    ["draft", "validated", "failed", "stamped", "confirmed"].includes(
      invoice.status,
    );
  const canCredit =
    capabilities.has("invoice.submit") &&
    invoice.kind === "invoice" &&
    ["stamped", "confirmed", "settled"].includes(invoice.status);
  const confirmationsDark = isFeatureDisabled(confirmationsError);
  const confirmationTimeline = [...(confirmations || [])].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
  const latestConfirmation =
    confirmationTimeline[confirmationTimeline.length - 1];
  const canRequestConfirmation =
    capabilities.has("confirmation.write") &&
    !confirmationsDark &&
    !confirmationsError &&
    confirmations !== undefined &&
    allowsConfirmationRequest(invoice.status, latestConfirmation);

  return {
    canWrite,
    canEdit,
    canSubmit,
    canClerkExplain,
    focus,
    canCancel,
    canCredit,
    confirmationsDark,
    confirmationTimeline,
    latestConfirmation,
    canRequestConfirmation,
  };
}

export type InvoiceAbilities = ReturnType<typeof invoiceAbilities>;
