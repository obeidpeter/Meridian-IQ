import { test, expect, describe } from "vitest";
import { confidenceBadgeClasses } from "./format";

// The shared formatters (naira/date/status/severity/confirmation) are tested
// once, in @workspace/format; this file covers only the SME-specific badge
// vocabulary kept in ./format.ts.

describe("confidenceBadgeClasses", () => {
  test("greens up as confidence rises, across the documented thresholds", () => {
    expect(confidenceBadgeClasses(0.95)).toContain("emerald");
    expect(confidenceBadgeClasses(0.9)).toContain("emerald");
    expect(confidenceBadgeClasses(0.75)).toContain("teal");
    expect(confidenceBadgeClasses(0.7)).toContain("teal");
    expect(confidenceBadgeClasses(0.6)).toContain("amber");
    expect(confidenceBadgeClasses(0.5)).toContain("amber");
    expect(confidenceBadgeClasses(0.3)).toContain("red");
  });

  test("accepts a numeric string and classifies it the same way", () => {
    expect(confidenceBadgeClasses("0.95")).toContain("emerald");
  });
});
