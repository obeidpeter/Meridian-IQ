/**
 * Pure display helpers behind the Deadlines tab's penalty-exposure card.
 * The figures are the server's (modules/invoice/penalty-exposure.ts — the
 * same s.104 model as the offline estimator in ./penalty.ts); this module
 * only phrases them, reusing formatNaira so naira renders one way
 * everywhere. Always the SMALL-band floor as the headline ("at least"),
 * never a scare figure — the platform does not hold the business's
 * turnover, so the honest single number is the lowest band's.
 */

import { formatNaira } from "./penalty";

export interface ExposureFigures {
  overdueCount: number;
  exposure: { small: string; large: string };
  perInvoice: { small: string };
}

/**
 * The card's headline sentence — the web dashboard card's exact shape:
 * overdue count, the small-band floor, the per-invoice charge, and how far
 * the higher bands reach.
 */
export function penaltyExposureLine(exposure: ExposureFigures): string {
  const n = exposure.overdueCount;
  return `${n} invoice${n === 1 ? " is" : "s are"} past the statutory submission window. Valo's s.104 planning estimate is ${formatNaira(
    Number(exposure.exposure.small),
  )} at the lowest turnover band (${formatNaira(
    Number(exposure.perInvoice.small),
  )} per invoice), rising to ${formatNaira(
    Number(exposure.exposure.large),
  )} at the highest band. These are not official penalty amounts.`;
}

// The fix, stated: this exposure is removable, not a verdict.
export const PENALTY_EXPOSURE_FIX_LINE =
  "Submit overdue invoices to resolve the outstanding submission work. This does not guarantee that any penalty will be waived.";

/** The estimate disclaimer with the server's as-of date already formatted. */
export function penaltyExposureNote(asOfLabel: string): string {
  return `Based on Valo's planning assumptions, not legal or tax advice. Check current official notices or speak to a tax advisor. As of ${asOfLabel}.`;
}
