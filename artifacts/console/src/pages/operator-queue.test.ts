import { test, expect, describe } from "vitest";
import { spendAlertsLine } from "./operator-queue";

// The operator brief's spend line: an attention-needed phrase pointing at the
// audit log when the sweep flagged firm spend anomalies today, and the same
// quiet all-clear treatment the sibling lines use at zero.

describe("spendAlertsLine", () => {
  test("is a quiet all-clear at zero", () => {
    expect(spendAlertsLine(0)).toBe("No firm spend anomalies today.");
  });

  test("pluralizes the anomaly count and points at the audit log", () => {
    expect(spendAlertsLine(1)).toBe(
      "1 firm spend anomaly today — check the audit log.",
    );
    expect(spendAlertsLine(3)).toBe(
      "3 firm spend anomalies today — check the audit log.",
    );
  });
});
