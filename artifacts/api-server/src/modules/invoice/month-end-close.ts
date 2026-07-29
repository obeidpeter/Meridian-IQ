import { lagosDateString } from "../../lib/lagos-time";
import { listUnbilledIncome } from "./unbilled-income";
import { listUnmatchedCredits } from "./unmatched-credits";
import { listMissingRecurringBills } from "./missing-bills";
import { computeDoublePaymentCheck } from "./double-payment";
import { computePenaltyExposure } from "./penalty-exposure";
import { pendingApprovals } from "./approvals";
import { listUnmatchedCollections } from "../collections/unmatched";

// Month-end close assistant (round-19 idea #2). The platform now runs seven
// independent deterministic advisories that a client discovers one card at a
// time; a month-end close is precisely the moment all of them should be
// looked at TOGETHER. This module composes them into one checklist — each
// item computed by its EXISTING function (the net-position "nothing
// recomputed" discipline: this module contains zero predicates of its own,
// so the checklist can never disagree with the card it summarizes). Zero
// model calls, nothing stored, advisory only — a human closes the month.
//
// Items whose underlying feature is off for the firm (the maker-checker
// approval policy) are OMITTED, not shown as zero — a checklist item for a
// policy the firm never adopted is noise (the approvals null-when-off rule).

export interface CloseItem {
  key: string;
  label: string;
  status: "clear" | "attention";
  count: number;
  // One sentence of what the count means / where to act — the checklist is
  // a table of contents, the linked card is the detail.
  detail: string;
}

export interface MonthEndClose {
  asOf: string;
  items: CloseItem[];
  attentionCount: number;
  note: string;
}

export async function computeMonthEndClose(
  firmId: string,
  clientPartyId: string,
  now: Date = new Date(),
): Promise<MonthEndClose> {
  // Sequential on purpose: each call is one indexed query pass, and the
  // request transaction serializes on the session anyway.
  const unbilled = await listUnbilledIncome(firmId, clientPartyId, now);
  const credits = await listUnmatchedCredits(firmId, clientPartyId, now);
  const missingBills = await listMissingRecurringBills(
    firmId,
    clientPartyId,
    now,
  );
  const doublePay = await computeDoublePaymentCheck(firmId, clientPartyId);
  const exposure = await computePenaltyExposure(firmId, clientPartyId);
  const approvals = await pendingApprovals(firmId, clientPartyId);
  const collections = await listUnmatchedCollections(firmId);
  const clientCollections = collections.accounts
    .filter((a) => a.clientPartyId === clientPartyId)
    .reduce((sum, a) => sum + a.count, 0);
  const doublePayCount =
    doublePay.multiPaid.length + doublePay.duplicateCandidates.length;

  const item = (
    key: string,
    label: string,
    count: number,
    detail: string,
  ): CloseItem => ({
    key,
    label,
    status: count > 0 ? "attention" : "clear",
    count,
    detail,
  });

  const items: CloseItem[] = [
    item(
      "overdue_submissions",
      "Overdue e-invoice submissions",
      exposure.overdueCount,
      exposure.overdueCount > 0
        ? `${exposure.overdueCount} invoice(s) are past the statutory window — at least NGN ${exposure.exposure.small} of estimated s.104 exposure (lowest band). Submitting them removes it.`
        : "Every invoice is inside the statutory submission window.",
    ),
    item(
      "unbilled_income",
      "Regular invoices not yet raised",
      unbilled.length,
      unbilled.length > 0
        ? "Buyers you bill on a monthly rhythm with nothing raised this cycle — income going unbilled."
        : "Every monthly billing habit is up to date.",
    ),
    item(
      "unmatched_credits",
      "Bank credits with no invoice",
      credits.count,
      credits.count > 0
        ? `NGN ${credits.totalAmount} arrived over ${credits.windowDays} days with no invoice behind it — if any of it is a sale, an e-invoice should exist.`
        : "Every reconciled bank credit traces to an invoice.",
    ),
    item(
      "missing_bills",
      "Expected vendor bills not captured",
      missingBills.length,
      missingBills.length > 0
        ? "Vendors that bill you monthly with nothing captured this cycle — input VAT going unclaimed."
        : "Every monthly vendor habit has this cycle's bill captured.",
    ),
    item(
      "double_payments",
      "Possible double payments",
      doublePayCount,
      doublePayCount > 0
        ? "Bills the payment evidence says were settled twice, or unpaid near-duplicates — review before paying anything else."
        : "No double-payment signals in the payment evidence.",
    ),
    ...(clientCollections > 0
      ? [
          item(
            "unmatched_collections",
            "Collection-account payments matching no invoice",
            clientCollections,
            `Payments arrived on your collection accounts (trailing ${collections.windowDays} days) that could not be bound to any invoice — reconcile against the provider statement.`,
          ),
        ]
      : [
          item(
            "unmatched_collections",
            "Collection-account payments matching no invoice",
            0,
            "Every collection-account payment bound to an invoice.",
          ),
        ]),
    // Approval item only when the maker-checker policy is ON for the firm
    // (null means off — a checklist line for a policy the firm never
    // adopted is noise).
    ...(approvals !== null
      ? [
          item(
            "pending_approvals",
            "Invoices awaiting a colleague's approval",
            approvals.count,
            approvals.count > 0
              ? `${approvals.count} invoice(s) cannot be submitted until a colleague approves${approvals.oldestDays !== null ? ` — the oldest has waited ${approvals.oldestDays} day(s)` : ""}.`
              : "Nothing is waiting on an approval.",
          ),
        ]
      : []),
  ];

  return {
    asOf: lagosDateString(now),
    items,
    attentionCount: items.filter((i) => i.status === "attention").length,
    note:
      "A composed view of the platform's deterministic advisories — each line is computed by the same check that powers its own card, so the two can never disagree. " +
      "Advisory only: review each item before acting, and see the linked card for the detail.",
  };
}
