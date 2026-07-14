import { test, expect, describe } from "vitest";
import {
  formatNaira,
  formatPct,
  formatDate,
  formatDateTime,
  humanize,
  statusTone,
  statusLabel,
  badgeClasses,
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

describe("formatPct", () => {
  test("returns the em-dash sentinel for null, undefined, and non-numeric input", () => {
    expect(formatPct(null)).toBe("—");
    expect(formatPct(undefined)).toBe("—");
    expect(formatPct("abc")).toBe("—");
  });

  test("scales a fraction to a percentage with one fraction digit by default", () => {
    expect(formatPct(0.5)).toBe("50.0%");
    expect(formatPct(1)).toBe("100.0%");
    expect(formatPct("0.5")).toBe("50.0%");
  });

  test("honours the digits argument", () => {
    expect(formatPct(0.125, 2)).toBe("12.50%");
    expect(formatPct(0.2, 0)).toBe("20%");
  });
});

describe("formatDate", () => {
  test("returns the em-dash sentinel for falsy and unparseable input", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate(undefined)).toBe("—");
    expect(formatDate("")).toBe("—");
    expect(formatDate("not-a-date")).toBe("—");
  });

  test("formats a Date as a day-short month-year string", () => {
    // Build the Date from local components so the rendered day cannot drift
    // across the test runner's timezone.
    const out = formatDate(new Date(2026, 0, 15));
    expect(out).toContain("15");
    expect(out).toContain("Jan");
    expect(out).toContain("2026");
  });
});

describe("formatDateTime", () => {
  test("returns the em-dash sentinel for falsy and unparseable input", () => {
    expect(formatDateTime(null)).toBe("—");
    expect(formatDateTime(undefined)).toBe("—");
    expect(formatDateTime("")).toBe("—");
    expect(formatDateTime("not-a-date")).toBe("—");
  });

  test("appends a 24-hour time to the date", () => {
    const out = formatDateTime(new Date(2026, 0, 15, 9, 5));
    expect(out).toContain("2026");
    // A HH:MM clock component is present regardless of ICU locale details.
    expect(out).toMatch(/\d{2}:\d{2}/);
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
  test("distinguishes the two statuses that share the draft tone", () => {
    expect(statusLabel("validated")).toBe("Validated");
    expect(statusLabel("draft")).toBe("Draft");
  });

  test("distinguishes the two statuses that share the stamped tone", () => {
    expect(statusLabel("confirmed")).toBe("Confirmed");
    expect(statusLabel("stamped")).toBe("Stamped");
  });

  test("labels the remaining tones", () => {
    expect(statusLabel("submitted")).toBe("Pending stamp");
    expect(statusLabel("settled")).toBe("Settled");
    expect(statusLabel("credited")).toBe("Credited");
    expect(statusLabel("failed")).toBe("Failed");
    expect(statusLabel("cancelled")).toBe("Cancelled");
  });

  test("humanizes an unknown status for its label", () => {
    expect(statusLabel("weird_state")).toBe("Weird state");
  });
});

describe("badgeClasses", () => {
  test("maps each lifecycle tone onto its pill colour", () => {
    expect(badgeClasses("stamped")).toContain("emerald");
    expect(badgeClasses("settled")).toContain("teal");
    expect(badgeClasses("credited")).toContain("violet");
    expect(badgeClasses("submitted")).toContain("amber");
    expect(badgeClasses("failed")).toContain("red");
    expect(badgeClasses("cancelled")).toContain("slate");
  });

  test("routes the draft tone and unknown statuses to their fallbacks", () => {
    // draft falls through the switch to the blue default...
    expect(badgeClasses("draft")).toContain("blue");
    // ...while a genuinely unknown status lands on slate.
    expect(badgeClasses("something-new")).toContain("slate");
  });
});
