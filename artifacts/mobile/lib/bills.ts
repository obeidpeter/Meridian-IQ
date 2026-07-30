/**
 * Pure helpers behind the Supplier bills screen: payStatus display mapping,
 * the payment-flag gate (flags record settlement EVIDENCE — "paid" is
 * terminal and re-flagging "scheduled" over itself is a no-op the UI must
 * not offer), the verification chip derived from the bill's stored stamp
 * check, and the missing-recurring-bills advisory copy. Kept free of React
 * Native imports so the node:test suite can exercise them directly; the
 * tone type is imported type-only from components/ui (erased at runtime,
 * so the suite still never loads React Native).
 */

import type { BadgeTone } from "@/components/ui";
import { formatCurrency, formatDate } from "./format";

export type BillFlagTarget = "scheduled" | "paid";

export type BillBadgeTone = BadgeTone;

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

// ---- Missing recurring bills advisory --------------------------------------
// Vendors whose bill arrives every month with nothing captured this cycle —
// an uncaptured bill is input VAT silently lost. Mined deterministically
// server-side (and capped there at its own display limit, quietly — the
// screen renders exactly what arrives, never a "+N more" of its own); the
// wording mirrors the SME web bills page.

export interface MissingBillPattern {
  supplierName: string;
  currency: string;
  medianAmount: string;
  medianGapDays: number;
  count: number;
  lastIssueDate: string;
  expectedByDate: string;
}

/** Currency-aware amount: NGN as naira, anything else as "USD 1200.00". */
function patternAmount(pattern: MissingBillPattern): string {
  return pattern.currency === "NGN"
    ? formatCurrency(pattern.medianAmount)
    : `${pattern.currency} ${pattern.medianAmount}`;
}

/** One advisory line per vendor habit — the web page's exact shape. */
export function missingBillLine(pattern: MissingBillPattern): string {
  return `${pattern.supplierName} has billed about ${patternAmount(
    pattern,
  )} roughly every ${pattern.medianGapDays} days (${pattern.count} bills on record, last ${formatDate(
    pattern.lastIssueDate,
  )}) — this cycle's bill was expected by ${formatDate(
    pattern.expectedByDate,
  )} and has not been captured.`;
}

export const MISSING_BILLS_HEADER = "Expected vendor bills not captured yet";

// The hedge: advisory only, and an ended arrangement is a fine reason to
// ignore it.
export const MISSING_BILLS_FOOTER =
  "Advisory only, from your own capture history. An uncaptured bill means unclaimed input VAT — if the vendor arrangement has ended, you can ignore this.";

/** The full advisory banner text: header, one line per pattern, hedge. */
export function missingBillsBannerMessage(
  patterns: readonly MissingBillPattern[],
): string {
  return [
    MISSING_BILLS_HEADER,
    ...patterns.map(missingBillLine),
    MISSING_BILLS_FOOTER,
  ].join("\n\n");
}
