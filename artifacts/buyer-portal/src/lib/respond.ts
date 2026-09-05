import type { ConfirmationInputState } from "@workspace/api-client-react";
import { errorStatus } from "./errors";

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
    "Accepts the invoice as issued. The supplier is notified, and with the no-set-off acknowledgement below the invoice becomes financeable.",
  queried:
    "Records your question and sends it to the supplier. You cannot change this response. Ask the supplier to clarify and send a new confirmation request; you can respond again when that request arrives.",
  rejected:
    "Declines the invoice. The supplier is notified with your reason and must reissue it if they still intend to bill you.",
};

// Said before submit, not only in the 409 and "already responded" states:
// a response is one-shot, whichever action is picked.
export const RESPONSE_FINALITY =
  "Once submitted, your response is recorded permanently and cannot be changed here.";

export const SUBMIT_LABELS: Record<ResponseState, string> = {
  confirmed: "Confirm invoice",
  queried: "Send query",
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
    ? "Say what needs clarifying — your note is all the supplier sees."
    : "Say why you are rejecting — your note is all the supplier sees.";
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
          "Your confirmation has been recorded and the supplier has been notified. Nothing more is needed from you on this invoice.",
      };
    case "queried":
      return {
        title: "Query sent",
        description:
          "Your question has been recorded. Ask the supplier to clarify and send a new confirmation request for the stamped invoice. You can respond to the new request, but this recorded response cannot be changed.",
      };
    case "rejected":
      return {
        title: "Invoice rejected",
        description:
          "Your rejection has been recorded and the supplier has been notified with your reason. They must reissue the invoice to bill you again.",
      };
  }
}

/** Map raw mutation failures to human copy; fall back to the server message. */
export function errorDescription(error: unknown): string {
  const status = errorStatus(error);
  if (status === 401)
    return "Your session has expired — sign in again from the portal.";
  if (status === 403) return "Your account doesn't have permission to do this.";
  if (status === 409)
    return "This invoice was already responded to — refresh to see the latest state.";
  if (status !== undefined && status >= 500)
    return "MeridianIQ had a problem recording this. Try again in a moment.";
  const message = error instanceof Error ? error.message : undefined;
  return message ?? "Something went wrong — try again.";
}
