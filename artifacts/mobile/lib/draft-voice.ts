/**
 * Pure mapping from a Clerk invoice-draft proposal (idea #7: "speak an
 * invoice into existence") onto the create-form's state. Every value here was
 * already re-validated/normalised by the SERVER (dates are real ISO dates,
 * VAT is a fraction, amounts are plain decimals); this module only translates
 * dialects — the API's fraction VAT to the form's percent VAT — and decides
 * which pieces of form state a proposal may touch. Buyer identity is only
 * ever applied when the server's deterministic suggestion is a party the
 * picker actually offers.
 */

import type { InvoiceDraftResult } from "@workspace/api-client-react";
import { blankLine, type LineDraft } from "./invoice-form";

// "0.075" (API fraction) -> "7.5" (form percent); null/garbage -> the
// standard-rate default the blank form uses.
export function fractionToPercent(vatRate: string | null | undefined): string {
  if (vatRate == null || vatRate.trim() === "") return "7.5";
  const n = Number(vatRate);
  if (!Number.isFinite(n) || n < 0 || n > 1) return "7.5";
  // Round away float artifacts (0.075 * 100 = 7.500000000000001).
  return String(Number((n * 100).toFixed(4)));
}

export interface AppliedDraft {
  invoiceNumber: string | null;
  issueDate: string | null;
  // Set only when the top suggestion is among the pickable buyers.
  buyerPartyId: string | null;
  // What Clerk read the customer as — shown as a hint when unmatched.
  buyerNameRead: string | null;
  // Null = the proposal had no usable lines; keep what the form has.
  lines: LineDraft[] | null;
}

export function applyDraftProposal(
  result: InvoiceDraftResult,
  pickableBuyerIds: string[],
  keyPrefix: string,
): AppliedDraft {
  const proposal = result.proposal;
  const top = result.buyerSuggestions[0];
  const buyerPartyId =
    top && pickableBuyerIds.includes(top.partyId) ? top.partyId : null;

  const lines: LineDraft[] = proposal.lines.map((l, i) => ({
    ...blankLine(`${keyPrefix}${i}`),
    description: l.description,
    quantity: l.quantity,
    unitPrice: l.unitPrice ?? "",
    vatRate: fractionToPercent(l.vatRate),
  }));

  return {
    invoiceNumber: proposal.invoiceNumber,
    issueDate: proposal.issueDate,
    buyerPartyId,
    buyerNameRead: proposal.buyerName,
    lines: lines.length > 0 ? lines : null,
  };
}
