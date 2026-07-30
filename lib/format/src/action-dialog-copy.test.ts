import { describe, expect, test } from "vitest";
import {
  ACTION_TARGET_DISPLAY_CAP,
  POLICY_CAP_DEFAULT,
  POLICY_CAP_MAX,
  POLICY_CAP_MIN,
  actionConfirmButtonLabel,
  actionConfirmDescription,
  actionOutcomeSummary,
  actionTargetOverflowNote,
  actionTruncatedNote,
  decisionLine,
  draftClipboardText,
  parsePolicyCap,
  policyGrantDescription,
  policyKindLabel,
  policyPauseReasonLabel,
  policyStatusLine,
} from "./index";

// The approve/results dialog copy (round-27 extraction). Both cards render
// these strings verbatim, and the app render pins drive the dialogs by
// testid, NOT by copy — so this file is the ONLY place the exact wording is
// pinned. Expected strings are byte-for-byte the pre-extraction JSX template
// output (em-dash, middot and audience clause included).

describe("actionConfirmDescription", () => {
  test("draft_chasers — SME audience, singular", () => {
    expect(actionConfirmDescription("draft_chasers", 1, "sme")).toBe(
      "This drafts 1 payment reminder for you to review, copy and send yourself — nothing is sent or submitted by the platform. Each invoice is re-checked at this moment, and the decision is recorded under your name.",
    );
  });

  test("draft_chasers — console audience, plural", () => {
    expect(actionConfirmDescription("draft_chasers", 3, "console")).toBe(
      "This drafts 3 payment reminders for the client to review and send — nothing is sent or submitted by the platform. Each invoice is re-checked at this moment, and the decision is recorded under your name.",
    );
  });

  test("retry_failed resubmits; other submit kinds submit", () => {
    expect(actionConfirmDescription("retry_failed", 2, "sme")).toBe(
      "This resubmits 2 invoices to the e-invoicing rails through the ordinary path — validation, consent and any approval policy all apply. Each invoice is re-checked at this moment; anything already processed or no longer eligible is skipped, and the decision is recorded under your name.",
    );
    expect(actionConfirmDescription("submit_overdue", 1, "console")).toBe(
      "This submits 1 invoice to the e-invoicing rails through the ordinary path — validation, consent and any approval policy all apply. Each invoice is re-checked at this moment; anything already processed or no longer eligible is skipped, and the decision is recorded under your name.",
    );
  });
});

describe("actionConfirmButtonLabel", () => {
  test("chaser batches draft; submit kinds approve; count pluralizes", () => {
    expect(actionConfirmButtonLabel("draft_chasers", 1)).toBe(
      "Draft 1 reminder",
    );
    expect(actionConfirmButtonLabel("draft_chasers", 4)).toBe(
      "Draft 4 reminders",
    );
    expect(actionConfirmButtonLabel("submit_overdue", 1)).toBe(
      "Approve 1 invoice",
    );
    expect(actionConfirmButtonLabel("retry_failed", 2)).toBe(
      "Approve 2 invoices",
    );
  });
});

describe("actionOutcomeSummary", () => {
  test("chaser decisions say drafted; submit decisions say submitted", () => {
    expect(
      actionOutcomeSummary({
        kind: "draft_chasers",
        executedCount: 3,
        failedCount: 1,
        skippedCount: 0,
      }),
    ).toBe("3 drafted · 1 need attention · 0 skipped.");
    expect(
      actionOutcomeSummary({
        kind: "submit_overdue",
        executedCount: 2,
        failedCount: 0,
        skippedCount: 1,
      }),
    ).toBe("2 submitted · 0 need attention · 1 skipped.");
  });
});

describe("draftClipboardText", () => {
  test("the pinned subject\\n\\nbody contract", () => {
    expect(
      draftClipboardText({ subject: "Payment reminder", body: "Good day." }),
    ).toBe("Payment reminder\n\nGood day.");
  });
});

test("the display cap both cards slice by stays 8", () => {
  expect(ACTION_TARGET_DISPLAY_CAP).toBe(8);
});

describe("actionTargetOverflowNote", () => {
  test("counts only what the display cap hid — the ellipsis and full stop included", () => {
    expect(actionTargetOverflowNote(ACTION_TARGET_DISPLAY_CAP + 1)).toBe(
      "…and 1 more.",
    );
    expect(actionTargetOverflowNote(20)).toBe("…and 12 more.");
  });
});

describe("actionTruncatedNote", () => {
  test("says what is shown, of how many, and what to do next", () => {
    expect(actionTruncatedNote(20, 45)).toBe(
      "Showing the oldest 20 of 45 — approve this batch, then come back for the rest.",
    );
  });
});

describe("decisionLine", () => {
  test("date, kind, the three counts — and · auto only on a policy run", () => {
    const auto = decisionLine({
      createdAt: "2026-07-29T05:00:00Z",
      kind: "submit_overdue",
      executedCount: 3,
      skippedCount: 1,
      failedCount: 0,
      policyId: "pol-1",
    });
    expect(auto).toMatch(
      / · submit_overdue · 3 executed · 1 skipped · 0 failed · auto$/,
    );
    const manual = decisionLine({
      createdAt: "2026-07-29T05:00:00Z",
      kind: "retry_failed",
      executedCount: 2,
      skippedCount: 0,
      failedCount: 1,
      policyId: null,
    });
    expect(manual).toMatch(
      / · retry_failed · 2 executed · 0 skipped · 1 failed$/,
    );
    expect(manual.includes("auto")).toBe(false);
  });
});

// ---- Standing approvals (round 28) ----------------------------------------

describe("policyKindLabel", () => {
  test("the automatable kinds have card labels; unknown kinds fall through raw", () => {
    expect(policyKindLabel("submit_overdue")).toBe(
      "Auto-submit overdue invoices",
    );
    expect(policyKindLabel("retry_failed")).toBe(
      "Auto-retry failed submissions",
    );
    expect(policyKindLabel("future_kind")).toBe("future_kind");
  });
});

describe("policyPauseReasonLabel", () => {
  test("the sweep's tripwire vocabulary, in card-sized words", () => {
    expect(policyPauseReasonLabel("manual")).toBe("paused manually");
    expect(policyPauseReasonLabel("grantor_inactive")).toBe(
      "paused — the granter's access changed",
    );
    expect(policyPauseReasonLabel("consent_missing")).toBe(
      "paused — compliance consent is missing",
    );
    expect(policyPauseReasonLabel("failed_targets")).toBe(
      "paused — too many failures in the last run",
    );
    expect(policyPauseReasonLabel("unknown_kind")).toBe(
      "paused — this action kind can't run automatically",
    );
    expect(policyPauseReasonLabel(null)).toBe("paused manually");
    expect(policyPauseReasonLabel("new_reason")).toBe("paused — new_reason");
  });
});

describe("policyStatusLine", () => {
  test("a paused grant leads with why; an active one says cadence, cap and last run", () => {
    expect(
      policyStatusLine({
        pausedAt: "2026-07-29T08:00:00Z",
        pausedReason: "failed_targets",
        maxTargetsPerRun: 50,
        lastRunAt: "2026-07-29T07:00:00Z",
      }),
    ).toBe("paused — too many failures in the last run");
    expect(
      policyStatusLine({
        pausedAt: null,
        pausedReason: null,
        maxTargetsPerRun: 10,
        lastRunAt: null,
      }),
    ).toBe("runs daily · up to 10 per run · has not run yet");
    const active = policyStatusLine({
      pausedAt: null,
      pausedReason: null,
      maxTargetsPerRun: 50,
      lastRunAt: "2026-07-28T06:10:00Z",
    });
    expect(active).toMatch(/^runs daily · up to 50 per run · last ran /);
  });
});

describe("policyGrantDescription", () => {
  test("says what runs, how many at most, under whose name, and that it is revocable — per audience", () => {
    expect(policyGrantDescription("submit_overdue", "sme", 10)).toBe(
      "Clerk will run this check every day and submit up to 10 invoices past the statutory window under your name, without asking again each day. Every run re-checks consent, your access and each invoice; you can pause or revoke this at any time, and every run is recorded.",
    );
    expect(policyGrantDescription("retry_failed", "console", 25)).toBe(
      "Clerk will run this check every day and resubmit up to 25 invoices that failed on the rails under your name, without a fresh approval each day. Every run re-checks consent, your access and each invoice; you can pause or revoke this at any time, and every run is recorded.",
    );
  });

  test("a cap of 1 reads singular", () => {
    expect(policyGrantDescription("submit_overdue", "console", 1)).toContain(
      "submit up to 1 invoice past the statutory window",
    );
    expect(policyGrantDescription("retry_failed", "sme", 1)).toContain(
      "resubmit up to 1 invoice that failed on the rails",
    );
  });
});

describe("parsePolicyCap", () => {
  test("accepts whole numbers within the contract's 1..50", () => {
    expect(parsePolicyCap("10")).toBe(10);
    expect(parsePolicyCap(" 1 ")).toBe(1);
    expect(parsePolicyCap("50")).toBe(50);
  });

  test("rejects empty, fractional, signed, non-numeric and out-of-range input", () => {
    expect(parsePolicyCap("")).toBeNull();
    expect(parsePolicyCap("0")).toBeNull();
    expect(parsePolicyCap("51")).toBeNull();
    expect(parsePolicyCap("2.5")).toBeNull();
    expect(parsePolicyCap("-3")).toBeNull();
    expect(parsePolicyCap("+3")).toBeNull();
    expect(parsePolicyCap("ten")).toBeNull();
  });

  test("the bounds mirror the contract and the default sits inside them", () => {
    expect(POLICY_CAP_MIN).toBe(1);
    expect(POLICY_CAP_MAX).toBe(50);
    expect(POLICY_CAP_DEFAULT).toBe(10);
    expect(parsePolicyCap(String(POLICY_CAP_DEFAULT))).toBe(POLICY_CAP_DEFAULT);
  });
});
