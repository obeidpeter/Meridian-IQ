import { test, expect, describe } from "vitest";
import { eligibleBadge, stampBadge } from "./format";

// The shared formatters are tested once, in @workspace/format; this file
// covers only the buyer-portal-specific boolean pill vocabulary.

describe("stampBadge", () => {
  test("labels a valid stamp emerald and everything else as slate 'No stamp'", () => {
    expect(stampBadge(true).label).toBe("Stamp valid");
    expect(stampBadge(true).classes).toContain("emerald");
    for (const v of [false, null, undefined]) {
      expect(stampBadge(v).label).toBe("No stamp");
      expect(stampBadge(v).classes).toContain("slate");
    }
  });
});

describe("eligibleBadge", () => {
  test("labels VAT eligibility emerald and everything else amber 'Not eligible'", () => {
    expect(eligibleBadge(true).label).toBe("VAT eligible");
    expect(eligibleBadge(true).classes).toContain("emerald");
    for (const v of [false, null, undefined]) {
      expect(eligibleBadge(v).label).toBe("Not eligible");
      expect(eligibleBadge(v).classes).toContain("amber");
    }
  });
});
