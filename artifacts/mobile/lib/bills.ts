/**
 * Pure helpers behind the Supplier bills screen: payStatus display mapping,
 * the payment-flag gate (flags record settlement EVIDENCE — "paid" is
 * terminal and re-flagging "scheduled" over itself is a no-op the UI must
 * not offer), and the verification chip derived from the bill's stored
 * stamp check. Kept free of React Native imports so the node:test suite can
 * exercise them directly; the tone union mirrors components/ui BadgeTone
 * structurally.
 */

export type BillFlagTarget = "scheduled" | "paid";

export type BillBadgeTone =
  | "neutral"
  | "success"
  | "warning"
  | "critical"
  | "info";

/** Buyer-side wording: an "open" bill reads as money still to pay. */
export function billStatusLabel(payStatus: string): string {
  switch (payStatus) {
    case "open":
      return "Unpaid";
    case "scheduled":
      return "Scheduled";
    case "paid":
      return "Paid";
    default:
      // Off-contract statuses from a newer server degrade to a title-cased
      // token, never a crash or an empty badge.
      return payStatus
        ? payStatus.charAt(0).toUpperCase() + payStatus.slice(1)
        : "Unknown";
  }
}

export function billStatusTone(payStatus: string): BillBadgeTone {
  switch (payStatus) {
    case "scheduled":
      return "warning";
    case "paid":
      return "success";
    default:
      return "neutral";
  }
}

/**
 * Whether a payment flag may be offered for a bill in `payStatus`:
 * - "paid" is terminal — the evidence already says settled, nothing more to
 *   flag either way;
 * - a "scheduled" bill can still be marked paid, but not re-scheduled;
 * - anything else (including off-contract statuses) stays flaggable rather
 *   than dead-ending the row.
 */
export function canFlag(payStatus: string, target: BillFlagTarget): boolean {
  if (payStatus === "paid") return false;
  if (target === "scheduled") return payStatus !== "scheduled";
  return true;
}

/**
 * The row chip for a bill's stored verification result, or null when the
 * stamp has never been checked (no chip beats a misleading "unverified"
 * alarm on a book that predates the feature).
 */
export function verificationChip(
  lastVerification: { valid: boolean } | null | undefined,
): { label: string; tone: BillBadgeTone } | null {
  if (!lastVerification) return null;
  return lastVerification.valid
    ? { label: "Stamp valid", tone: "success" }
    : { label: "Stamp not found", tone: "critical" };
}
