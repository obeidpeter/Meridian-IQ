import { sql, type SQL } from "drizzle-orm";
import type { Invoice } from "@workspace/db";
import { lagosMidnightPlusDays } from "../../lib/lagos-time";

// The statutory submission-window / penalty-risk cluster shared by the partner
// console (CON-02) and the SME dashboard (SME-05), so the two surfaces cannot
// drift apart.

const DAY_MS = 24 * 60 * 60 * 1000;

// SMEs must submit an issued invoice for stamping within this window; past it the
// invoice is on penalty watch (SME-05).
export const SUBMISSION_WINDOW_DAYS = 7;

// ---------------------------------------------------------------------------
// The ONE home for the submission-window SQL pieces (refactoring round),
// written against alias `i` like receivables.ts's OUTSTANDING so every
// consumer spells them identically. Before this, the boundary predicate was
// copied verbatim across the digest, the penalty card, the scorecard, Ask
// Clerk and the proposed-actions catalogue — five surfaces whose whole
// promise is that they can never disagree, held together by comments.
// Callers pass their own `today` (each site captures lagosTodaySql() —
// see lib/lagos-time.ts for why current_date is wrong here).
// ---------------------------------------------------------------------------

// Not yet on the rails: the states a submit action can still act on.
export const UNSUBMITTED_STATE = sql`i.status IN ('draft', 'validated')`;

// The deadline is Lagos midnight STARTING day issue+window, so an invoice is
// overdue ON that day (<=) — the boundary every consumer shares.
export function pastSubmissionDeadline(today: SQL): SQL {
  return sql`i.issue_date + ${SUBMISSION_WINDOW_DAYS}::int <= ${today}`;
}

// Inside the window but with 7 days or less of it left.
export function withinDueSoonWindow(today: SQL): SQL {
  return sql`i.issue_date + ${SUBMISSION_WINDOW_DAYS}::int > ${today}
            AND i.issue_date + ${SUBMISSION_WINDOW_DAYS}::int <= ${today} + 7`;
}

// Days past the deadline as an int (negative while still inside the window —
// callers clamp where "0 days past" is the honest floor).
export function daysPastDeadline(today: SQL): SQL {
  return sql`(${today} - (i.issue_date + ${SUBMISSION_WINDOW_DAYS}::int))::int`;
}

export function daysUntil(target: Date, from: Date): number {
  return Math.floor((target.getTime() - from.getTime()) / DAY_MS);
}

export function isUnsubmitted(s: Invoice["status"]): boolean {
  return s === "draft" || s === "validated";
}

export function isStamped(s: Invoice["status"]): boolean {
  return s === "stamped" || s === "confirmed" || s === "settled";
}

// The statutory submit-by instant for an invoice issued on `issueDate`: Lagos
// midnight after the window elapses, so "overdue" flips at the local calendar
// boundary rather than an hour later at UTC midnight. SQL predicates that
// prefilter on this deadline must use the matching
// `(issue_date + N)::timestamp AT TIME ZONE 'Africa/Lagos'` expression.
export function submissionDeadline(issueDate: string): Date {
  return lagosMidnightPlusDays(issueDate, SUBMISSION_WINDOW_DAYS);
}

export function penaltyRisk(
  overdueCount: number,
  failedCount: number,
  dueSoon: boolean,
): "low" | "medium" | "high" {
  return overdueCount > 0 || failedCount > 1
    ? "high"
    : failedCount > 0 || dueSoon
      ? "medium"
      : "low";
}
