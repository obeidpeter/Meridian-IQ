import {
  type CashflowBucket,
  type PayablesSummaryGroupsItem,
} from "@workspace/api-client-react";

// First-run nudge gate: the quiet "create your first invoice" link renders
// ONLY when the client has no invoices AT ALL — an active book whose
// receivables happen to be settled has earned silence, not a nag. Undefined
// (summary still loading or failed) shows nothing rather than guessing.
export function showFirstInvoiceCta(
  totalInvoices: number | undefined,
): boolean {
  return totalInvoices === 0;
}

/**
 * The payables card keeps three visual buckets (mirroring the receivables
 * card's at-a-glance shape): Overdue, Due this week (dueWeeks[0]), and
 * everything beyond — the remaining weekly buckets folded into `later`.
 * Exported for the unit tests.
 */
export function dueLaterBucket(
  group: PayablesSummaryGroupsItem,
): CashflowBucket {
  const rest = group.dueWeeks.slice(1);
  const amount =
    rest.reduce((sum, w) => sum + Number(w.amount), 0) +
    Number(group.later.amount);
  const count = rest.reduce((sum, w) => sum + w.count, 0) + group.later.count;
  return { amount: amount.toFixed(2), count };
}

// "2026-06-01" -> "June 2026" for the statement's display period.
const STATEMENT_MONTHS = [
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

export function statementMonthLabel(monthStart: string): string {
  const [y, m] = monthStart.split("-");
  return `${STATEMENT_MONTHS[Number(m) - 1] ?? m} ${y}`;
}

// Run monthly (round 33, Do with Clerk Phase 3): a standing approval for
// the month_end_close plan. The sweep mints ONE run per Lagos month per
// grant — the exact machinery the "Run with Clerk" button above drives by
// hand, per-step re-validation and decision-ledger rows included. Tripwires
// (a halted run, the approver losing access, a closed engagement, missing
// consent) pause the grant rather than let it keep running.
const PLAN_PAUSE_LABELS: Record<string, string> = {
  manual: "Paused",
  run_halted: "Paused — the last run halted",
  grantor_inactive: "Paused — the approver's access changed",
  engagement_closed: "Paused — the engagement closed",
  consent_missing: "Paused — compliance consent is missing",
  unknown_template: "Paused — the plan template changed",
  run_error: "Paused — the last run hit an error",
};

// "Up to date for", not "last ran": a month is also consumed by the honest
// closing-window empty (nothing was eligible all month), and the hourly
// sweep — not a month-end event — picks up the first eligible paper.
export function planPolicyStatusLine(p: {
  pausedAt?: string | null;
  pausedReason?: string | null;
  lastRunMonth?: string | null;
}): string {
  if (p.pausedAt) return PLAN_PAUSE_LABELS[p.pausedReason ?? ""] ?? "Paused";
  return p.lastRunMonth
    ? `Runs monthly · up to date for ${p.lastRunMonth}`
    : "Runs monthly · runs when there is eligible paper";
}

// The week bucket labels the cash-flow outlook and net-position cards
// share: index 0 is the week in progress.
export const weekLabel = (i: number) =>
  i === 0 ? "This week" : i === 1 ? "Next week" : `Week +${i}`;

export const DASHBOARD_VIEWS = [
  "today",
  "money",
  "compliance",
  "clerk",
] as const;

export type DashboardView = (typeof DASHBOARD_VIEWS)[number];
