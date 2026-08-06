// WHT Desk display vocabulary — the ONE home for the withholding-tax
// category and credit-status labels, shared by console, the SME app and
// (later) mobile so the surfaces can never drift (the filing-copy lesson).
// The RATES deliberately do not live here: basis points and expected-WHT
// arithmetic are server business (modules/wht/rates.ts) and the frontends
// only ever echo amounts the server computed. The percentage in each label
// is wording, not arithmetic.
//
// This module must import NOTHING (the filing-copy subpath rule): it is
// exported as "@workspace/format/wht-copy" so the mobile app can share the
// wording without executing the package root's module-load Intl formatter
// construction.

// The closed catalogue (2025 Deduction at Source regulations, corporate
// recipients) — keys mirror the contract's whtCategory enum.
export const WHT_CATEGORY_LABELS: Record<string, string> = {
  goods_2: "Supply of goods — 2%",
  works_2: "Construction & works — 2%",
  services_5: "Services & professional fees — 5%",
  commission_5: "Commission & brokerage — 5%",
  rent_10: "Rent & hire — 10%",
  royalties_10: "Royalties — 10%",
};

export const WHT_CREDIT_STATUS_LABELS: Record<string, string> = {
  awaiting_note: "Awaiting credit note",
  note_received: "Credit note received",
};

function fallbackLabel(raw: string | null | undefined): string {
  const spaced = (raw ?? "").replace(/[_-]+/g, " ").trim();
  if (!spaced) return "Unknown";
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Null/undefined reads as the honest default: no WHT applies. */
export function whtCategoryLabel(raw: string | null | undefined): string {
  if (raw === null || raw === undefined || raw === "") return "No WHT";
  return WHT_CATEGORY_LABELS[raw] ?? fallbackLabel(raw);
}

export function whtCreditStatusLabel(raw: string | null | undefined): string {
  return WHT_CREDIT_STATUS_LABELS[raw ?? ""] ?? fallbackLabel(raw);
}
