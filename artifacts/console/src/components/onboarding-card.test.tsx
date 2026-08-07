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
import type { OnboardingRun } from "@workspace/api-client-react";
import {
  onboardingStepLabel,
  onboardingStepPill,
  onboardingProgress,
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
