import type { Invoice } from "@workspace/db";

// The statutory submission-window / penalty-risk cluster shared by the partner
// console (CON-02) and the SME dashboard (SME-05), so the two surfaces cannot
// drift apart.

const DAY_MS = 24 * 60 * 60 * 1000;

// SMEs must submit an issued invoice for stamping within this window; past it the
// invoice is on penalty watch (SME-05).
export const SUBMISSION_WINDOW_DAYS = 7;

export function daysUntil(target: Date, from: Date): number {
  return Math.floor((target.getTime() - from.getTime()) / DAY_MS);
}

export function isUnsubmitted(s: Invoice["status"]): boolean {
  return s === "draft" || s === "validated";
}

export function isStamped(s: Invoice["status"]): boolean {
  return s === "stamped" || s === "confirmed" || s === "settled";
}

// The statutory submit-by date for an invoice issued on `issueDate`.
export function submissionDeadline(issueDate: string): Date {
  const d = new Date(issueDate);
  d.setUTCDate(d.getUTCDate() + SUBMISSION_WINDOW_DAYS);
  return d;
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
