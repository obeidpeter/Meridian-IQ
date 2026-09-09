/**
 * Status-keyed toast title for a failed submit (the billing paymentErrorCopy
 * pattern): a 409 is the server refusing on purpose — an orientation guard
 * or the approval policy — not a transport error, so the title says
 * "blocked" and the description relays the server's own words.
 */
export function submitErrorTitle(status: number | undefined): string {
  return status === 409 ? "Submission blocked" : "Submission error";
}

/**
 * Post-submit toast copy, honest about delivery: only firms with the
 * messaging rail lit are ever notified — for everyone else this page is
 * where the answer lands (it polls while the invoice is pending).
 */
export function submittedToastDescription(
  features: string[] | undefined,
): string {
  return (features ?? []).includes("messaging_notifications")
    ? "We'll notify you once it clears the rail."
    : "Check back here — this page updates automatically once FIRS answers.";
}
