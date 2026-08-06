// Filing Desk display vocabulary — the ONE home for the returns register's
// status labels, the filing-kind labels, and the period wording, shared by
// console, the SME app and (later) mobile so the three can never drift
// (the notice-copy lesson). Tax-type LABELS stay in notice-copy's
// TAX_TYPE_LABELS — one vocabulary for "VAT"/"PAYE" across notices and
// filings; this module re-exports the helper so consumers import one path.
//
// This module must import NOTHING except its notice-copy sibling (which
// itself imports nothing): it is exported as the
// "@workspace/format/filing-copy" subpath so the mobile app can share the
// wording without executing the package root's module-load Intl formatter
// construction (the action-copy precedent).

import { taxTypeLabel, TAX_TYPE_LABELS } from "./notice-copy";

export { taxTypeLabel, TAX_TYPE_LABELS };

export const FILING_STATUS_LABELS: Record<string, string> = {
  upcoming: "Upcoming",
  prepared: "Prepared",
  filed: "Filed",
};

function fallbackLabel(raw: string | null | undefined): string {
  const spaced = (raw ?? "").replace(/[_-]+/g, " ").trim();
  if (!spaced) return "Unknown";
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function filingStatusLabel(raw: string | null | undefined): string {
  return FILING_STATUS_LABELS[raw ?? ""] ?? fallbackLabel(raw);
}

// The filing kinds' own display names — what the RETURN is called, distinct
// from the tax-type token ("VAT return" vs "VAT").
export const FILING_KIND_LABELS: Record<string, string> = {
  vat: "VAT return",
  paye: "PAYE remittance",
  wht: "WHT remittance",
  // The annual layer (Compliance Profile round): minted only for clients
  // whose profile says the duty exists.
  cit: "CIT return",
  cac_annual: "CAC annual return",
  paye_annual: "PAYE annual return",
};

export function filingKindLabel(raw: string | null | undefined): string {
  return FILING_KIND_LABELS[raw ?? ""] ?? fallbackLabel(raw);
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "2026-07" → "July 2026"; anything unparseable comes back verbatim. */
export function filingPeriodLabel(period: string): string {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  if (!Number.isInteger(year) || !Number.isInteger(month)) return period;
  const name = MONTH_NAMES[month - 1];
  return name ? `${name} ${year}` : period;
}
