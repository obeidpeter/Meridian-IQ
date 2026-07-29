import { describe, expect, test } from "vitest";
import {
  ACTION_TARGET_DISPLAY_CAP,
  actionConfirmButtonLabel,
  actionConfirmDescription,
  actionOutcomeSummary,
  draftClipboardText,
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
  test("says what runs, under whose name, and that it is revocable — per audience", () => {
    expect(policyGrantDescription("submit_overdue", "sme")).toBe(
      "Clerk will run this check every day and submit invoices past the statutory window under your name, without asking again each day. Every run re-checks consent, your access and each invoice; you can pause or revoke this at any time, and every run is recorded.",
    );
    expect(policyGrantDescription("retry_failed", "console")).toBe(
      "Clerk will run this check every day and resubmit invoices that failed on the rails under your name, without a fresh approval each day. Every run re-checks consent, your access and each invoice; you can pause or revoke this at any time, and every run is recorded.",
    );
  });
});
