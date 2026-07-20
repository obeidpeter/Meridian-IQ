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
    "Sends the invoice back with your question. The supplier sees your note and can correct or clarify before you accept — nothing is finalised.",
  rejected:
    "Declines the invoice. The supplier is notified with your reason and must reissue it if they still intend to bill you.",
};

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
          "Your question has been recorded and the supplier has been notified. They can correct or clarify the invoice before you accept it.",
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
  if (status === 403)
    return "Your account doesn't have permission to do this.";
  if (status === 409)
    return "This invoice was already responded to — refresh to see the latest state.";
  if (status !== undefined && status >= 500)
    return "MeridianIQ had a problem recording this. Try again in a moment.";
  const message = error instanceof Error ? error.message : undefined;
  return message ?? "Something went wrong — try again.";
}
