import { test, expect, describe } from "vitest";
import type { ClaimGapReport } from "@workspace/api-client-react";
import { claimGapSummary } from "./clerk-claims";

// The claim-gaps card's headline sentence: refusals against the window when
// the register left questions unanswered, an all-clear otherwise.

const report = (over: Partial<ClaimGapReport>): ClaimGapReport => ({
  windowDays: 30,
  totalQuestions: 40,
  refusedTotal: 3,
  byReason: [],
  uncovered: [],
  ...over,
});

describe("claimGapSummary", () => {
  test("phrases refusals against the total and the window", () => {
    expect(claimGapSummary(report({}))).toBe(
      "3 of 40 question(s) refused in the last 30 days.",
    );
    expect(
      claimGapSummary(report({ windowDays: 90, totalQuestions: 1, refusedTotal: 1 })),
    ).toBe("1 of 1 question(s) refused in the last 90 days.");
  });

  test("reads as an all-clear when nothing was refused", () => {
    const out = claimGapSummary(report({ refusedTotal: 0 }));
    expect(out).toBe(
      "No refused questions in the last 30 days — the register covered everything Ask Clerk was asked.",
    );
  });

  test("the empty state follows refusedTotal, not totalQuestions", () => {
    // A window can have zero questions asked at all — still an all-clear.
    expect(
      claimGapSummary(report({ refusedTotal: 0, totalQuestions: 0 })),
    ).toContain("No refused questions");
  });
});
