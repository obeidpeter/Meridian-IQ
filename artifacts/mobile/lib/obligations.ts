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
import {
  OBLIGATION_DUE_SOON_DAYS,
  deadlineDaysUntil,
  obligationStatusLabel,
} from "@workspace/format/notice-copy";
import { formatCurrency } from "./format";

// The words and the day-math come from @workspace/format/notice-copy — the
// one home for the notice/authority vocabulary and the deadline arithmetic
// shared with the console and SME apps (an Intl-free subpath, like
// action-copy, so both Metro and the node:test suite can load it). Only the
// badge TONES below stay per-app. Re-exported so screens and tests keep
// their "@/lib/obligations" imports.
export {
  AUTHORITY_LABELS,
  NOTICE_TYPE_LABELS,
  authorityLabel,
  localDayIso,
  noticeTypeLabel,
} from "@workspace/format/notice-copy";

export const DUE_SOON_WINDOW_DAYS = OBLIGATION_DUE_SOON_DAYS;

/**
 * The row badge: only an OPEN obligation escalates on its deadline (overdue =
 * due date before today, due soon = within the next 7 days including today) —
 * a responded or closed one has been dealt with, so it never reads as
 * overdue. Deadline display logic only, computed client-side; the status
 * itself is the firm's record. Takes todayIso explicitly so the mapping is a
 * pure function of its inputs (no hidden clock).
 *
 * Deliberate wording split (the action-copy idiom: texts differ only where
 * the audience does): the open badge reads "Open"/"Due soon"/"Overdue" — a
 * phone worklist voice — not the shared OBLIGATION_STATUS_LABELS' "Awaiting
 * response" that the SME web rows use.
 */
export function obligationBadge(
  status: string,
  responseDueDate: string,
  todayIso: string,
): { label: string; tone: BadgeTone } {
  if (status === "responded") return { label: "Responded", tone: "success" };
  if (status === "closed") return { label: "Closed", tone: "neutral" };
  if (status !== "open") {
    // Off-contract status from a newer server: a plain badge, never a crash
    // (the shared status labeler title-cases anything off-catalogue).
    return { label: obligationStatusLabel(status), tone: "neutral" };
  }
  const days = deadlineDaysUntil(todayIso, responseDueDate);
  if (Number.isNaN(days)) return { label: "Open", tone: "info" };
  if (days < 0) return { label: "Overdue", tone: "critical" };
  if (days <= OBLIGATION_DUE_SOON_DAYS) return { label: "Due soon", tone: "warning" };
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
