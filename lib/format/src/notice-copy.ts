// Notice Desk display vocabulary — the ONE home for the notice-type /
// authority / tax-type label maps, the obligation status labels, and the
// deadline day-math that decides which badge a row wears. Before refactor
// round 7 these were triplicated (console clerk-shared.ts, SME
// obligations.tsx, mobile lib/obligations.ts) and had already drifted
// ("Other notice" vs "Notice"). The maps' KEYS are the contract's closed
// catalogues; an off-catalogue token from a newer server degrades to a
// title-cased word, never a crash. Badge TONES stay per-app (CSS pill
// classes vs React Native tones) — only the words and the arithmetic live
// here.
//
// This module must import NOTHING: it is exported as the
// "@workspace/format/notice-copy" subpath so the mobile app can share the
// wording without executing the package root's module-load Intl formatter
// construction (the action-copy precedent).

export const NOTICE_TYPE_LABELS: Record<string, string> = {
  assessment: "Assessment",
  demand: "Demand notice",
  information_request: "Information request",
  audit: "Audit notice",
  penalty: "Penalty notice",
  reminder: "Reminder",
  other: "Other notice",
};

export const AUTHORITY_LABELS: Record<string, string> = {
  firs: "FIRS",
  state_irs: "State IRS",
  customs: "Customs",
  other: "Other authority",
};

export const TAX_TYPE_LABELS: Record<string, string> = {
  vat: "VAT",
  cit: "CIT",
  wht: "WHT",
  paye: "PAYE",
  stamp_duty: "Stamp duty",
  other: "Other",
};

// The manual's documented status vocabulary (open obligations "await" the
// firm's response).
export const OBLIGATION_STATUS_LABELS: Record<string, string> = {
  open: "Awaiting response",
  responded: "Responded",
  closed: "Closed",
};

function fallbackLabel(raw: string | null | undefined): string {
  const spaced = (raw ?? "").replace(/[_-]+/g, " ").trim();
  if (!spaced) return "Unknown";
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function noticeTypeLabel(raw: string | null | undefined): string {
  return NOTICE_TYPE_LABELS[raw ?? ""] ?? fallbackLabel(raw);
}

export function authorityLabel(raw: string | null | undefined): string {
  return AUTHORITY_LABELS[raw ?? ""] ?? fallbackLabel(raw);
}

export function taxTypeLabel(raw: string | null | undefined): string {
  return TAX_TYPE_LABELS[raw ?? ""] ?? fallbackLabel(raw);
}

export function obligationStatusLabel(raw: string | null | undefined): string {
  return OBLIGATION_STATUS_LABELS[raw ?? ""] ?? fallbackLabel(raw);
}

// Days remaining until an obligation's response deadline, on the 7-day
// due-soon window every surface shares.
export const OBLIGATION_DUE_SOON_DAYS = 7;

/** Local calendar day as YYYY-MM-DD — the `todayIso` the deadline math wants. */
export function localDayIso(at: Date): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(
    at.getDate(),
  ).padStart(2, "0")}`;
}

/**
 * Whole calendar days from todayIso to dateIso (negative = past); NaN when
 * either is unparseable — callers treat NaN as "no flag", never a crash.
 */
export function deadlineDaysUntil(todayIso: string, dateIso: string): number {
  const a = new Date(todayIso);
  const b = new Date(dateIso);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return NaN;
  const dayA = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const dayB = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  return Math.round((dayB - dayA) / (24 * 60 * 60 * 1000));
}
