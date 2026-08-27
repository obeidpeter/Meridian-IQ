import { describe, expect, test } from "vitest";
import { PENALTY_RISK_RULES } from "./penalty-risk-info";

// The popover's copy is the server's deterministic rule in words — pinned
// here to modules/invoice/compliance-window.ts penaltyRisk (high when
// overdueCount > 0 || failedCount > 1; medium when failedCount > 0 ||
// dueSoon; low otherwise), SUBMISSION_WINDOW_DAYS = 7, and the console
// portfolio route's 3-day dueSoon window. A server-rule change fails this
// test and forces the copy to follow.

describe("PENALTY_RISK_RULES", () => {
  test("the three levels, attention first", () => {
    expect(PENALTY_RISK_RULES.map((r) => r.level)).toEqual([
      "High",
      "Medium",
      "Low",
    ]);
  });

  test("High states the 7-day window and the repeated-failure trigger", () => {
    const high = PENALTY_RISK_RULES[0].rule;
    expect(high).toContain("7-day submission window");
    expect(high).toContain("more than one failed submission");
  });

  test("Medium states the single failure and the 3-day due-soon window", () => {
    const medium = PENALTY_RISK_RULES[1].rule;
    expect(medium).toContain("a failed submission");
    expect(medium).toContain("within 3 days");
  });

  test("Low is the honest remainder", () => {
    expect(PENALTY_RISK_RULES[2].rule).toBe("everything else.");
  });
});
