// Shared formatters, the pill design language and the invoice-lifecycle /
// confirmation helpers live in the workspace package; this module keeps only
// the buyer-portal-specific badge vocabularies.
export * from "@workspace/format";

import { pillClasses } from "@workspace/format";

// ---- Buyer rails: boolean stamp / eligibility pills ------------------------
// One home for the wording pairs so "No stamp" / "VAT eligible" read the same
// on the queue and on the invoice detail page.

export function stampBadge(stampValid: boolean | null | undefined): {
  label: string;
  classes: string;
} {
  return stampValid
    ? { label: "Stamp valid", classes: pillClasses("emerald") }
    : { label: "No stamp", classes: pillClasses("slate") };
}

export function eligibleBadge(eligible: boolean | null | undefined): {
  label: string;
  classes: string;
} {
  return eligible
    ? { label: "VAT eligible", classes: pillClasses("emerald") }
    : { label: "Not eligible", classes: pillClasses("amber") };
}

/**
 * The compact risk token a list row shows below the lg breakpoint, where the
 * full stamp/eligibility badges are hidden: only the RISK states are named
 * (an invalid stamp, input VAT at risk) so a healthy row stays one line.
 * Returns null when there is nothing to warn about.
 */
export function stampRiskLabel(invoice: {
  stampValid?: boolean | null;
  eligible?: boolean | null;
}): string | null {
  const parts: string[] = [];
  if (!invoice.stampValid) parts.push(stampBadge(false).label);
  if (!invoice.eligible) parts.push(eligibleBadge(false).label);
  return parts.length === 0 ? null : parts.join(" · ");
}
