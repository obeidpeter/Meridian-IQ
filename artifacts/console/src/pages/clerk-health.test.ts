import { test, expect, describe } from "vitest";
import type { ClerkMetricsCases } from "@workspace/api-client-react";
import {
  fmtEvalDuration,
  fmtMs,
  fmtTokens,
  fmtUsd,
  casesTileDetail,
  overrideRateClass,
} from "./clerk-health";

describe("overrideRateClass", () => {
  test("reddens above 25%, ambers above 10%, and is blank at or below 10%", () => {
    expect(overrideRateClass(0.3)).toContain("red");
    expect(overrideRateClass(0.26)).toContain("red");
    expect(overrideRateClass(0.2)).toContain("amber");
    expect(overrideRateClass(0.11)).toContain("amber");
    // The thresholds are strict `>`, so the boundary values fall to the lower
    // band: exactly 25% is amber, exactly 10% is blank.
    expect(overrideRateClass(0.25)).toContain("amber");
    expect(overrideRateClass(0.1)).toBe("");
    expect(overrideRateClass(0.05)).toBe("");
    expect(overrideRateClass(0)).toBe("");
  });
});

describe("fmtEvalDuration", () => {
  test("shows whole milliseconds below one second", () => {
    expect(fmtEvalDuration(0)).toBe("0 ms");
    expect(fmtEvalDuration(250)).toBe("250 ms");
    expect(fmtEvalDuration(999)).toBe("999 ms");
    expect(fmtEvalDuration(4.6)).toBe("5 ms"); // rounds
  });

  test("switches to one-decimal seconds at and above one second", () => {
    expect(fmtEvalDuration(1000)).toBe("1.0 s");
    expect(fmtEvalDuration(1500)).toBe("1.5 s");
    expect(fmtEvalDuration(12340)).toBe("12.3 s");
  });
});

describe("fmtMs", () => {
  test("returns the em-dash sentinel for nullish latencies", () => {
    expect(fmtMs(null)).toBe("—");
    expect(fmtMs(undefined)).toBe("—");
  });

  test("rounds a present latency to whole milliseconds", () => {
    expect(fmtMs(0)).toBe("0 ms");
    expect(fmtMs(42.4)).toBe("42 ms");
  });
});

describe("fmtTokens", () => {
  test("returns the em-dash sentinel for nullish counts", () => {
    expect(fmtTokens(null)).toBe("—");
    expect(fmtTokens(undefined)).toBe("—");
  });

  test("rounds and renders a present count", () => {
    expect(fmtTokens(0)).toBe("0");
    // Assert the rounded digits are present without pinning the ICU grouping
    // separator, which follows the runtime's default locale.
    const out = fmtTokens(1234.6);
    expect(out).not.toBe("—");
    expect(out).toContain("235");
  });
});

describe("fmtUsd", () => {
  test("returns the em-dash sentinel when spend is nullish (rates not configured)", () => {
    expect(fmtUsd(null)).toBe("—");
    expect(fmtUsd(undefined)).toBe("—");
  });

  test("formats USD with 2–4 fraction digits (locale is pinned to en-US)", () => {
    expect(fmtUsd(1.5)).toContain("1.50");
    expect(fmtUsd(0.0001)).toContain("0.0001");
  });
});

describe("casesTileDetail", () => {
  const base: ClerkMetricsCases = {
    total: 0,
    byStatus: {},
    byKind: {},
  };

  test("returns undefined when no timing is available", () => {
    expect(casesTileDetail(base)).toBeUndefined();
  });

  test("rounds and includes only the timings that are present", () => {
    expect(casesTileDetail({ ...base, avgDecisionMinutes: 12.4 })).toBe(
      "avg decision 12 min",
    );
    expect(
      casesTileDetail({
        ...base,
        avgDecisionMinutes: 12,
        avgQueueWaitMinutes: 3,
        avgActiveReviewMinutes: 9,
      }),
    ).toBe("avg decision 12 min · queue wait 3m · active review 9m");
  });

  test("treats a zero timing as present (guards on != null, not truthiness)", () => {
    expect(casesTileDetail({ ...base, avgQueueWaitMinutes: 0 })).toBe(
      "queue wait 0m",
    );
  });
});
