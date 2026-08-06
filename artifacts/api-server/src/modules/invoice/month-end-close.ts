import { lagosDateString } from "../../lib/lagos-time";
import { listUnbilledIncome } from "./unbilled-income";
import { listUnmatchedCredits } from "./unmatched-credits";
import { listMissingRecurringBills } from "./missing-bills";
import { computeDoublePaymentCheck } from "./double-payment";
import { computePenaltyExposure } from "./penalty-exposure";
import { pendingApprovals } from "./approvals";
import {
  countClientUnmatchedCollections,
  UNMATCHED_COLLECTIONS_WINDOW_DAYS,
} from "../collections/unmatched";
import {
  OBLIGATION_DUE_SOON_DAYS,
  countOpenObligations,
} from "../obligations/obligations";
import {
  FILING_DUE_SOON_DAYS,
  countOpenFilings,
} from "../filings/filings";
import { countWhtChase } from "../wht/credits";

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
  const clientCollections = await countClientUnmatchedCollections(
    firmId,
    clientPartyId,
  );
  const obligations = await countOpenObligations(firmId, clientPartyId);
  const filings = await countOpenFilings(firmId, clientPartyId);
  const whtChase = await countWhtChase(firmId, clientPartyId);
  const doublePayCount =
    doublePay.multiPaid.length + doublePay.duplicateCandidates.length;

  // Three source lists are capped at their own detector's display limit
  // (unbilled/missing at 5, double-payment at 20 per lane); when a count
  // sits AT the cap the detail says so — a saturated "(5)" must never read
  // as exactly five.
  const capped = (n: number, cap: number, detail: string): string =>
    n >= cap ? `${detail} Showing the detector's top ${cap} — more may exist.` : detail;

  // The checklist's ONE predicate (count > 0) picks both the status and
  // which detail sentence shows, spelled once here so the two can never
  // disagree. Both strings are built eagerly at every call site — they are
  // pure interpolations, so the unused one renders harmlessly.
  const item = (
    key: string,
    label: string,
    count: number,
    attention: string,
    clear: string,
  ): CloseItem => ({
    key,
    label,
    status: count > 0 ? "attention" : "clear",
    count,
    detail: count > 0 ? attention : clear,
  });

  const items: CloseItem[] = [
    item(
      "overdue_submissions",
      "Overdue e-invoice submissions",
      exposure.overdueCount,
      `${exposure.overdueCount} invoice(s) are past the statutory window — at least NGN ${exposure.exposure.small} of estimated s.104 exposure (lowest band). ${approvals !== null ? "Approving and submitting" : "Submitting"} them removes it.`,
      "Every invoice is inside the statutory submission window.",
    ),
    item(
      "unbilled_income",
      "Regular invoices not yet raised",
      unbilled.length,
      capped(
        unbilled.length,
        5,
        "Buyers you bill on a monthly rhythm with nothing raised this cycle — income going unbilled.",
      ),
      "Every monthly billing habit is up to date.",
    ),
    item(
      "unmatched_credits",
      "Bank credits with no invoice",
      credits.count,
      `NGN ${credits.totalAmount} arrived over ${credits.windowDays} days with no invoice behind it — if any of it is a sale, an e-invoice should exist.`,
      "Every reconciled bank credit traces to an invoice.",
    ),
    item(
      "missing_bills",
      "Expected vendor bills not captured",
      missingBills.length,
      capped(
        missingBills.length,
        5,
        "Vendors that bill you monthly with nothing captured this cycle — input VAT going unclaimed.",
      ),
      "Every monthly vendor habit has this cycle's bill captured.",
    ),
    item(
      "double_payments",
      "Possible double payments",
      doublePayCount,
      // The detector caps each LANE at 20 — saturation is per lane, so
      // the combined count triggers the hedge only when a lane is full
      // ("(30)" from 15+15 lists everything and must not hedge).
      `Bills the payment evidence says were settled twice, or unpaid near-duplicates — review before paying anything else.${
        doublePay.multiPaid.length >= 20 ||
        doublePay.duplicateCandidates.length >= 20
          ? " Showing the detector's top 20 per check — more may exist."
          : ""
      }`,
      "No double-payment signals in the payment evidence.",
    ),
    item(
      "unmatched_collections",
      "Collection-account payments matching no invoice",
      clientCollections,
      `Payments arrived on your collection accounts (trailing ${UNMATCHED_COLLECTIONS_WINDOW_DAYS} days) that could not be bound to any invoice — reconcile against the provider statement.`,
      "Every collection-account payment bound to an invoice.",
    ),
    // Authority obligations (Notice Desk): the deadlines here are the
    // AUTHORITY's, not the platform's, so a month must not close with one
    // unlooked-at. Computed by the obligations module's single fact function
    // — this module keeps zero predicates of its own.
    item(
      "open_obligations",
      "Authority obligations",
      obligations.open,
      `${obligations.open} authority notice(s) await a response — ${obligations.dueSoon} due within ${OBLIGATION_DUE_SOON_DAYS} days, ${obligations.overdue} overdue${obligations.nearestDue ? `; the nearest response is due ${obligations.nearestDue}` : ""}.`,
      "No authority notices are awaiting a response.",
    ),
    // Statutory returns (Filing Desk): the register's filing dates are the
    // authority's too, so a month must not close with a return unfiled.
    // Computed by the filings module's single fact function — this module
    // keeps zero predicates of its own.
    item(
      "open_filings",
      "Statutory returns",
      filings.unfiled,
      `${filings.unfiled} unfiled return(s) for the period — ${filings.dueSoon} due within ${FILING_DUE_SOON_DAYS} days, ${filings.overdue} overdue${filings.nextDueDate ? `; the next filing is due ${filings.nextDueDate}` : ""}. Prepare and file before the statutory date.`,
      "No unfiled returns on the register.",
    ),
    // Withholding credit notes (WHT Desk): recorded deductions whose buyer
    // credit note is still outstanding — undocumented claimable credit a
    // month must not close without chasing. Computed by the WHT module's
    // single chase fact function — this module keeps zero predicates of its
    // own.
    item(
      "wht_credits",
      "WHT credit notes",
      whtChase.awaiting,
      `${whtChase.awaiting} recorded withholding deduction(s) still lack the buyer's credit note — NGN ${whtChase.awaitingAmount} of claimable credit is undocumented. Chase the buyers for the notes.`,
      "Every recorded withholding deduction has its credit note.",
    ),
    // Approval item only when the maker-checker policy is ON for the firm
    // (null means off — a checklist line for a policy the firm never
    // adopted is noise).
    ...(approvals !== null
      ? [
          item(
            "pending_approvals",
            "Invoices awaiting a colleague's approval",
            approvals.count,
            `${approvals.count} invoice(s) cannot be submitted until a colleague approves${approvals.oldestDays !== null ? ` — the oldest has waited ${approvals.oldestDays} day(s)` : ""}.`,
            "Nothing is waiting on an approval.",
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
