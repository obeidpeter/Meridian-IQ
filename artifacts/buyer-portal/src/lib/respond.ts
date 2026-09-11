import type { ConfirmationInputState } from "@workspace/api-client-react";
import { errorStatus } from "./errors";
import { userErrorMessage } from "@workspace/api-errors";

// The confirm/query/reject response flow's pure logic, extracted from the
// invoice-respond page so the copy and the validation rules are testable and
// stay in one place.

export type ResponseState = Extract<
  ConfirmationInputState,
  "confirmed" | "queried" | "rejected"
>;

// What each action actually DOES — shown under the toggle so the buyer picks
// with the consequence in view, not from a one-word label.
export const RESPONSE_DESCRIPTIONS: Record<ResponseState, string> = {
  confirmed:
    "Records that you accept the invoice as issued. The supplier can view your response. The no-set-off acknowledgement below can support a financing assessment. It does not approve financing or make a payment.",
  queried:
    "Records your question for the supplier to review. You cannot change this response. Ask the supplier to clarify and send a new confirmation request; you can respond again when that request arrives.",
  rejected:
    "Records that you reject the invoice. The supplier can review your reason before correcting it or sending a new confirmation request.",
};

// Said before submit, not only in the 409 and "already responded" states:
// a response is one-shot, whichever action is picked.
export const RESPONSE_FINALITY =
  "Once submitted, your response is recorded permanently and cannot be changed here.";

export const SUBMIT_LABELS: Record<ResponseState, string> = {
  confirmed: "Confirm invoice",
  queried: "Send question",
  rejected: "Reject invoice",
};

/** A query or rejection travels back to the supplier as your note — required. */
export function noteRequiredFor(state: ResponseState | null): boolean {
  return state === "queried" || state === "rejected";
}

/**
 * Validation message for the note, or null when the response can be
 * submitted. Confirmations never require a note; queries and rejections
 * require a non-blank one, with a message that says why.
 */
export function noteValidationError(
  state: ResponseState | null,
  note: string,
): string | null {
  if (!noteRequiredFor(state)) return null;
  if (note.trim() !== "") return null;
  return state === "queried"
    ? "Enter your question so the supplier knows what to clarify."
    : "Enter a reason so the supplier knows why you are rejecting this invoice.";
}

/** The post-action confirmation card's copy, per recorded response. */
export function responseRecordedCopy(state: ResponseState): {
  title: string;
  description: string;
} {
  switch (state) {
    case "confirmed":
      return {
        title: "Invoice confirmed",
        description:
          "Your confirmation has been recorded. The supplier can view your recorded response. No further response is needed here. This does not record a payment.",
      };
    case "queried":
      return {
        title: "Question sent",
        description:
          "Your question has been recorded. Ask the supplier to clarify and send a new confirmation request for the stamped invoice. You can respond to the new request, but this recorded response cannot be changed.",
      };
    case "rejected":
      return {
        title: "Invoice rejected",
        description:
          "Your rejection has been recorded. The supplier can view your recorded response and reason. Contact them about any corrections or a new confirmation request.",
      };
  }
}

/** Map raw mutation failures to human copy; fall back to the server message. */
export function errorDescription(error: unknown): string {
  const status = errorStatus(error);
  if (status === 401)
    return "Your session has expired. Sign in again to continue.";
  if (status === 403) return "Your account doesn't have permission to do this.";
  if (status === 409)
    return (
      userErrorMessage(error) ??
      "This action could not be completed with the invoice's current status. Refresh to review the latest status."
    );
  if (status !== undefined && status >= 500)
    return "Valo could not confirm the result. Check the latest invoice status before trying again.";
  return (
    userErrorMessage(error) ??
    "Valo could not confirm the result. Check the latest invoice status before trying again."
  );
}
