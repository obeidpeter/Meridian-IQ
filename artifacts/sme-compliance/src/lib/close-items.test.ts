import { describe, expect, test } from "vitest";
import { closeAttentionCount, visibleCloseItems } from "./close-items";

const items = [
  { key: "overdue_submissions", status: "attention" as const },
  { key: "unbilled_income", status: "clear" as const },
  { key: "pending_approvals", status: "attention" as const },
  { key: "open_filings", status: "attention" as const },
  { key: "wht_credits", status: "clear" as const },
  { key: "missing_bills", status: "attention" as const },
  { key: "unmatched_credits", status: "attention" as const },
  { key: "unmatched_collections", status: "clear" as const },
];

describe("visibleCloseItems", () => {
  test("a launch-profile account sees only the invoice-core lanes", () => {
    expect(visibleCloseItems(items, ["clerk_ai"]).map((i) => i.key)).toEqual([
      "overdue_submissions",
      "unbilled_income",
      "pending_approvals",
    ]);
  });

  test("lighting a feature reveals exactly its lanes", () => {
    expect(
      visibleCloseItems(items, ["statutory_desks"]).map((i) => i.key),
    ).toEqual([
      "overdue_submissions",
      "unbilled_income",
      "pending_approvals",
      "open_filings",
      "wht_credits",
    ]);
    expect(
      visibleCloseItems(items, ["money_analytics", "reconciliation"]).map(
        (i) => i.key,
      ),
    ).toContain("unmatched_credits");
  });

  test("an unknown lane key from a newer server is shown, never dropped", () => {
    const withNew = [
      ...items,
      { key: "brand_new_lane", status: "clear" as const },
    ];
    expect(visibleCloseItems(withNew, []).map((i) => i.key)).toContain(
      "brand_new_lane",
    );
  });
});

describe("closeAttentionCount", () => {
  test("counts attention over the visible lanes only", () => {
    expect(closeAttentionCount(items)).toBe(5);
    expect(closeAttentionCount(visibleCloseItems(items, []))).toBe(2);
  });
});
