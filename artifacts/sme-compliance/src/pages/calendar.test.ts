import { test, expect, describe } from "vitest";
import { deadlineBadgeText } from "./calendar";

describe("deadlineBadgeText", () => {
  test("overdue names the state without a redundant suffix", () => {
    expect(deadlineBadgeText("overdue", -3)).toBe("Overdue · 3 days");
    expect(deadlineBadgeText("overdue", -1)).toBe("Overdue · 1 day");
    // Intraday clocks (B2C 24h) can be overdue on their own Lagos day.
    expect(deadlineBadgeText("overdue", 0)).toBe("Overdue");
  });

  test("due_soon and upcoming pair the state word with the countdown", () => {
    expect(deadlineBadgeText("due_soon", 0)).toBe("Due soon · today");
    expect(deadlineBadgeText("due_soon", 2)).toBe("Due soon · in 2 days");
    expect(deadlineBadgeText("upcoming", 1)).toBe("On track · in 1 day");
    expect(deadlineBadgeText("upcoming", 20)).toBe("On track · in 20 days");
  });

  test("met reads Done with no countdown", () => {
    expect(deadlineBadgeText("met", 5)).toBe("Done");
    expect(deadlineBadgeText("met", null)).toBe("Done");
  });

  test("off-contract statuses humanize; a missing diff drops the countdown", () => {
    expect(deadlineBadgeText("weird_state", 2)).toBe("Weird state · in 2 days");
    expect(deadlineBadgeText("upcoming", null)).toBe("On track");
  });
});
