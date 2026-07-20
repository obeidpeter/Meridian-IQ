import { test, expect, describe } from "vitest";
import type { ClaimGapReport } from "@workspace/api-client-react";
import {
  claimGapSummary,
  seededDraftState,
  shouldConfirmSeedOverwrite,
} from "./clerk-claims";

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

// Gap-to-claim wiring: "Draft claim from this" seeds the Draft-with-Clerk
// panel. Only a seed — drafting still takes the operator's click and the
// draft still walks maker-checker.
describe("seededDraftState", () => {
  test("opens the panel with the question VERBATIM — never rephrased, trimmed or prefixed", () => {
    const question = "  What is the VAT rate on exported services? ";
    expect(seededDraftState(question)).toEqual({
      draftOpen: true,
      draftText: question,
      draftError: null,
      draftSuccess: null,
    });
  });

  test("clears any stale error or success from an earlier drafting attempt", () => {
    const seed = seededDraftState("Is B2C reporting monthly?");
    expect(seed.draftError).toBeNull();
    expect(seed.draftSuccess).toBeNull();
    expect(seed.draftOpen).toBe(true);
  });
});

// The seed's dirty-panel guard: replacing non-empty DIFFERING panel text needs
// the operator's explicit OK; everything else seeds silently.
describe("shouldConfirmSeedOverwrite", () => {
  test("an empty or whitespace-only panel seeds without asking", () => {
    expect(shouldConfirmSeedOverwrite("", "What is the VAT rate?")).toBe(false);
    expect(shouldConfirmSeedOverwrite("   \n ", "What is the VAT rate?")).toBe(
      false,
    );
  });

  test("non-empty differing text requires the confirmation", () => {
    expect(
      shouldConfirmSeedOverwrite(
        "Half-written statutory context the operator typed…",
        "What is the VAT rate?",
      ),
    ).toBe(true);
  });

  test("re-seeding the SAME question is not an overwrite — no interruption", () => {
    expect(
      shouldConfirmSeedOverwrite("What is the VAT rate?", "What is the VAT rate?"),
    ).toBe(false);
    // …including when only surrounding whitespace differs.
    expect(
      shouldConfirmSeedOverwrite(
        "  What is the VAT rate? ",
        "What is the VAT rate?",
      ),
    ).toBe(false);
  });
});
