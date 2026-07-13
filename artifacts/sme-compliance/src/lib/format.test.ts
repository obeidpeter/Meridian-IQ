import { test, expect, describe } from "vitest";
import {
  formatNaira,
  humanize,
  statusTone,
  statusLabel,
  confidenceBadgeClasses,
} from "./format";

describe("formatNaira", () => {
  test("returns the em-dash sentinel for null, undefined, and non-numeric input", () => {
    expect(formatNaira(null)).toBe("—");
    expect(formatNaira(undefined)).toBe("—");
    expect(formatNaira("abc")).toBe("—");
  });

  test("formats numeric values as NGN currency with 2 fraction digits", () => {
    // Assert the grouped/decimal number part rather than the ICU currency
    // symbol so the test survives ICU variance.
    expect(formatNaira(150000)).toContain("150,000.00");
    expect(formatNaira("1234.5")).toContain("1,234.50");
    expect(formatNaira(0)).not.toBe("—");
  });
});

describe("humanize", () => {
  test("replaces underscores/hyphens with spaces and upper-cases the first char", () => {
    expect(humanize("buyer_flag")).toBe("Buyer flag");
    expect(humanize("credit-note")).toBe("Credit note");
    expect(humanize("multi__word--thing")).toBe("Multi word thing");
  });

  test("returns 'Unknown' for empty, whitespace-only, and nullish input", () => {
    expect(humanize("")).toBe("Unknown");
    expect(humanize("   ")).toBe("Unknown");
    expect(humanize(null)).toBe("Unknown");
    expect(humanize(undefined)).toBe("Unknown");
  });

  test("preserves the casing of characters after the first", () => {
    expect(humanize("already Nice")).toBe("Already Nice");
  });
});

describe("statusTone", () => {
  test("collapses raw lifecycle statuses onto tone buckets", () => {
    expect(statusTone("draft")).toBe("draft");
    expect(statusTone("validated")).toBe("draft");
    expect(statusTone("submitted")).toBe("pending");
    expect(statusTone("stamped")).toBe("stamped");
    expect(statusTone("confirmed")).toBe("stamped");
    expect(statusTone("settled")).toBe("settled");
    expect(statusTone("credited")).toBe("credited");
    expect(statusTone("failed")).toBe("failed");
    expect(statusTone("cancelled")).toBe("cancelled");
  });

  test("falls back to 'unknown' for unrecognised statuses", () => {
    expect(statusTone("something-new")).toBe("unknown");
  });
});

describe("statusLabel", () => {
  test("labels each tone, distinguishing validated/draft and confirmed/stamped", () => {
    expect(statusLabel("validated")).toBe("Validated");
    expect(statusLabel("draft")).toBe("Draft");
    expect(statusLabel("submitted")).toBe("Pending stamp");
    expect(statusLabel("confirmed")).toBe("Confirmed");
    expect(statusLabel("stamped")).toBe("Stamped");
    expect(statusLabel("settled")).toBe("Settled");
  });

  test("humanizes an unknown status for its label", () => {
    expect(statusLabel("weird_state")).toBe("Weird state");
  });
});

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
