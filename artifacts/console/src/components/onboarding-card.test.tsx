// The onboarding checklist card's pure kernels (Onboard with Clerk Phase 1).
// The pins:
//  - Step labels are the card's own closed vocabulary over the contract's
//    closed step-key enum — an off-catalogue key from a newer server
//    degrades to the raw key, never a crash.
//  - Pill tones: done emerald, skipped slate (a recorded gap, not an
//    achievement), pending amber — never red; onboarding is a checklist,
//    not an overdue alarm.
//  - Progress counts done AND skipped as settled — the run completes on
//    done-or-skipped, so the card must count the same way.
//  - The card shows the ACTIVE run when one exists, else the newest row
//    (the server lists active-first, newest-first).
import { describe, expect, test } from "vitest";
import type {
  OnboardingRun,
  OpeningPosition,
} from "@workspace/api-client-react";
import {
  onboardingStepLabel,
  onboardingStepPill,
  onboardingProgress,
  openingSummaryLines,
  pickOnboardingRun,
} from "./onboarding-card";

function run(over: Partial<OnboardingRun> = {}): OnboardingRun {
  return {
    id: "run-1",
    clientPartyId: "cp-1",
    clientName: "Adaeze Foods",
    status: "active",
    steps: [
      {
        key: "consent_captured",
        status: "done",
        evidence: {},
        gaps: [],
        skippedReason: null,
        checkedAt: "2026-08-07T08:00:00Z",
      },
      {
        key: "history_imported",
        status: "skipped",
        evidence: {},
        gaps: [],
        skippedReason: "Newly incorporated",
        checkedAt: "2026-08-07T08:00:00Z",
      },
      {
        key: "statements_backfilled",
        status: "pending",
        evidence: {},
        gaps: ["No bank statement covers 2026-07"],
        skippedReason: null,
        checkedAt: "2026-08-07T08:00:00Z",
      },
    ],
    createdAt: "2026-08-07T07:00:00Z",
    completedAt: null,
    ...over,
  };
}

describe("onboardingStepLabel", () => {
  test("closed vocabulary; an unknown key degrades to itself", () => {
    expect(onboardingStepLabel("consent_captured")).toBe("Consent captured");
    expect(onboardingStepLabel("filings_synced")).toBe(
      "Filings register backfilled",
    );
    expect(
      onboardingStepLabel("future_step" as Parameters<typeof onboardingStepLabel>[0]),
    ).toBe("future_step");
  });
});

describe("onboardingStepPill", () => {
  test("done emerald, skipped slate, pending amber — never red", () => {
    expect(onboardingStepPill({ status: "done" })).toEqual({
      tone: "emerald",
      label: "Done",
    });
    expect(onboardingStepPill({ status: "skipped" })).toEqual({
      tone: "slate",
      label: "Skipped",
    });
    expect(onboardingStepPill({ status: "pending" })).toEqual({
      tone: "amber",
      label: "Pending",
    });
  });
});

describe("onboardingProgress", () => {
  test("done and skipped both settle; pending does not", () => {
    expect(onboardingProgress(run())).toBe("2 of 3 settled");
  });
});

describe("pickOnboardingRun", () => {
  test("active wins over newer terminal rows; else the first (newest)", () => {
    const active = run({ id: "r-active", status: "active" });
    const done = run({ id: "r-done", status: "completed" });
    expect(pickOnboardingRun([done, active])?.id).toBe("r-active");
    expect(pickOnboardingRun([done])?.id).toBe("r-done");
    expect(pickOnboardingRun([])).toBeNull();
  });
});

function position(over: Partial<OpeningPosition> = {}): OpeningPosition {
  return {
    computedAt: "2026-08-07T08:00:00Z",
    provisional: false,
    history: {
      invoiceCount: 12,
      earliestIssueDate: "2026-05-03",
      latestIssueDate: "2026-08-01",
    },
    receivables: {
      asOf: "2026-08-07",
      groups: [
        {
          currency: "NGN",
          outstandingTotal: "450000.00",
          invoiceCount: 4,
          buckets: {
            current: { amount: "450000.00", count: 4 },
            days31to60: { amount: "0", count: 0 },
            days61to90: { amount: "0", count: 0 },
            days90plus: { amount: "0", count: 0 },
          },
        },
      ],
      topDebtors: [],
    } as unknown as OpeningPosition["receivables"],
    payables: { clientPartyId: "cp-1", groups: [], topSuppliers: [] } as unknown as OpeningPosition["payables"],
    vat: { netVat: "12000.00" } as unknown as OpeningPosition["vat"],
    filings: { unfiled: 3, dueSoon: 1, overdue: 2, nextDueDate: "2026-08-21" },
    wht: { awaiting: 0, awaitingAmount: "0" },
    obligations: { open: 0, dueSoon: 0, overdue: 0, nearestDue: null },
    automation: {
      windowMonths: 6,
      asOf: "2026-08-07",
      kinds: [
        {
          kind: "reconcile_matches",
          sample: 40,
          agreed: 35,
          disagreed: 5,
          pending: 2,
          agreementRate: 0.875,
          medianLeadDays: null,
          exposureFloorNgn: null,
          note: "",
        },
        {
          kind: "draft_recurring",
          sample: 0,
          agreed: 0,
          disagreed: 0,
          pending: 0,
          agreementRate: null,
          medianLeadDays: null,
          exposureFloorNgn: null,
          note: "",
        },
      ],
    } as unknown as OpeningPosition["automation"],
    ...over,
  };
}

describe("openingSummaryLines", () => {
  test("reading order; empty sections stay silent; evidence lines only with decided history", () => {
    const lines = openingSummaryLines(position());
    const labels = lines.map((l) => l.label);
    expect(labels).toEqual([
      "Invoice history",
      "Outstanding receivables",
      "Net VAT (this month)",
      "Unfiled returns",
      "Receipt matching evidence",
    ]);
    expect(lines[0].value).toBe("12 invoice(s), 2026-05-03 → 2026-08-01");
    expect(lines[1].value).toBe("NGN 450000.00 across 4 invoice(s)");
    expect(lines[3].value).toBe("3 unfiled (2 overdue)");
    expect(lines[4].value).toBe("88% agreement over 40 decision(s)");
  });

  test("an empty book reads honestly and WHT/notices appear only when present", () => {
    const lines = openingSummaryLines(
      position({
        history: {
          invoiceCount: 0,
          earliestIssueDate: null,
          latestIssueDate: null,
        },
        receivables: { asOf: "2026-08-07", groups: [], topDebtors: [] } as unknown as OpeningPosition["receivables"],
        filings: { unfiled: 0, dueSoon: 0, overdue: 0, nextDueDate: null },
        wht: { awaiting: 2, awaitingAmount: "10000.00" },
        obligations: { open: 1, dueSoon: 0, overdue: 1, nearestDue: "2026-08-15" },
        automation: {
          windowMonths: 6,
          asOf: "2026-08-07",
          kinds: [],
        } as unknown as OpeningPosition["automation"],
      }),
    );
    const byLabel = new Map(lines.map((l) => [l.label, l.value]));
    expect(byLabel.get("Invoice history")).toBe("0 invoices on record");
    expect(byLabel.has("Outstanding receivables")).toBe(false);
    expect(byLabel.get("Unfiled returns")).toBe("None");
    expect(byLabel.get("WHT credit notes awaited")).toBe("2 (10000.00)");
    expect(byLabel.get("Open authority notices")).toBe("1 (1 overdue)");
  });
});
