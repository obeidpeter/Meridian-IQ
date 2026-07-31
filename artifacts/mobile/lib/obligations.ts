/**
 * Pure helpers behind the Obligations screen: the notice-type / authority
 * label vocabularies, the status+deadline → badge mapping, and the one-line
 * detail composer for a row. Obligations are recorded by the firm when it
 * approves a captured tax-authority notice — this app only READS them, so
 * everything here is display logic; the deadline math never decides anything
 * beyond which badge a row wears. Kept free of React Native imports so the
 * node:test suite can exercise it directly (the components/ui import is
 * type-only and erased at runtime).
 */

import type { BadgeTone } from "@/components/ui";
import { formatCurrency } from "./format";

// The server's closed catalogues (CreateObligationInput). An off-catalogue
// token from a newer server degrades to a title-cased word, never a crash.
export const NOTICE_TYPE_LABELS: Record<string, string> = {
  assessment: "Assessment",
  demand: "Demand notice",
  information_request: "Information request",
  audit: "Audit notice",
  penalty: "Penalty notice",
  reminder: "Reminder",
  other: "Notice",
};

export const AUTHORITY_LABELS: Record<string, string> = {
  firs: "FIRS",
  state_irs: "State IRS",
  customs: "Customs",
  other: "Other authority",
};

function fallbackLabel(token: string): string {
  const spaced = token.replace(/[_-]+/g, " ").trim();
  if (!spaced) return "Unknown";
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function noticeTypeLabel(noticeType: string): string {
  return NOTICE_TYPE_LABELS[noticeType] ?? fallbackLabel(noticeType);
}

export function authorityLabel(authority: string): string {
  return AUTHORITY_LABELS[authority] ?? fallbackLabel(authority);
}

/** Local calendar day as YYYY-MM-DD — the `todayIso` the badge helper wants. */
export function localDayIso(at: Date): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(
    at.getDate(),
  ).padStart(2, "0")}`;
}

/** Whole calendar days from todayIso to dateIso; NaN when either is unparseable. */
function daysBetween(todayIso: string, dateIso: string): number {
  const a = new Date(todayIso);
  const b = new Date(dateIso);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return NaN;
  const dayA = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const dayB = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  return Math.round((dayB - dayA) / 86_400_000);
}

export const DUE_SOON_WINDOW_DAYS = 7;

/**
 * The row badge: only an OPEN obligation escalates on its deadline (overdue =
 * due date before today, due soon = within the next 7 days including today) —
 * a responded or closed one has been dealt with, so it never reads as
 * overdue. Deadline display logic only, computed client-side; the status
 * itself is the firm's record. Takes todayIso explicitly so the mapping is a
 * pure function of its inputs (no hidden clock).
 */
export function obligationBadge(
  status: string,
  responseDueDate: string,
  todayIso: string,
): { label: string; tone: BadgeTone } {
  if (status === "responded") return { label: "Responded", tone: "success" };
  if (status === "closed") return { label: "Closed", tone: "neutral" };
  if (status !== "open") {
    // Off-contract status from a newer server: a plain badge, never a crash.
    return { label: fallbackLabel(status), tone: "neutral" };
  }
  const days = daysBetween(todayIso, responseDueDate);
  if (Number.isNaN(days)) return { label: "Open", tone: "info" };
  if (days < 0) return { label: "Overdue", tone: "critical" };
  if (days <= DUE_SOON_WINDOW_DAYS) return { label: "Due soon", tone: "warning" };
  return { label: "Open", tone: "info" };
}

export interface ObligationLineParts {
  reference?: string | null;
  period?: string | null;
  amount?: string | null;
  currency?: string | null;
}

/** Currency-aware amount: NGN as naira, anything else as "USD 1200.00". */
function amountPart(o: ObligationLineParts): string | null {
  if (!o.amount) return null;
  if (o.currency && o.currency !== "NGN") return `${o.currency} ${o.amount}`;
  return formatCurrency(o.amount);
}

/**
 * The row's detail line: reference · period · amount, with blank parts
 * contributing nothing (a notice often carries only some of the three).
 * Empty string when none are present so callers can skip the line entirely.
 */
export function obligationLine(o: ObligationLineParts): string {
  return [
    o.reference ? `Ref ${o.reference}` : null,
    o.period || null,
    amountPart(o),
  ]
    .filter(Boolean)
    .join(" · ");
}
