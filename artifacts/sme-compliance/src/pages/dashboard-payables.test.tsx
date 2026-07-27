// @vitest-environment jsdom
// The dashboard's Payables card: committed outflows from the bills book,
// mirroring the receivables card's shape but holding to THREE visual buckets
// — Overdue, Due this week (dueWeeks[0]), and everything later folded
// together. Render-on-success: no card while loading/failed/empty.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { PayablesSummary } from "@workspace/api-client-react";

const harness = vi.hoisted(() => ({
  summary: undefined as unknown,
  isSuccess: false,
  reset() {
    this.summary = undefined;
    this.isSuccess = false;
  },
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useGetPayablesSummary: () => ({
      data: harness.summary,
      isSuccess: harness.isSuccess,
    }),
  };
});

// Import AFTER the mock so the page module binds the stand-ins.
import { dueLaterBucket, PayablesCard } from "./dashboard";

function summary(): PayablesSummary {
  return {
    clientPartyId: "cp-1",
    groups: [
      {
        currency: "NGN",
        overdue: { amount: "120000.00", count: 2 },
        dueWeeks: [
          { startDate: "2026-07-27", amount: "50000.00", count: 1 },
          { startDate: "2026-08-03", amount: "30000.00", count: 1 },
          { startDate: "2026-08-10", amount: "0.00", count: 0 },
          { startDate: "2026-08-17", amount: "20000.00", count: 1 },
        ],
        later: { amount: "80000.00", count: 2 },
        total: { amount: "300000.00", count: 7 },
      },
    ],
    topSuppliers: [
      {
        supplierPartyId: "sp-1",
        supplierName: "Dangote Cement",
        amount: "170000.00",
        count: 3,
      },
    ],
  };
}

afterEach(cleanup);
beforeEach(() => {
  harness.reset();
});

describe("dueLaterBucket", () => {
  test("folds the remaining weekly buckets into later, keeping three visual buckets", () => {
    expect(dueLaterBucket(summary().groups[0])).toEqual({
      amount: "130000.00",
      count: 4,
    });
  });

  test("a group with only the current week degrades to the later bucket alone", () => {
    const group = summary().groups[0];
    group.dueWeeks = [group.dueWeeks[0]];
    expect(dueLaterBucket(group)).toEqual({ amount: "80000.00", count: 2 });
  });
});

describe("PayablesCard", () => {
  test("renders total, the three buckets, top suppliers and the bills link", () => {
    harness.summary = summary();
    harness.isSuccess = true;
    render(<PayablesCard clientPartyId="cp-1" />);

    const card = screen.getByTestId("card-payables");
    expect(screen.getByTestId("text-payables-total").textContent).toContain(
      "300,000",
    );
    expect(card.textContent).toContain("Committed across 7 bills");
    expect(card.textContent).toContain("Overdue");
    expect(card.textContent).toContain("Due this week");
    expect(card.textContent).toContain("Due later");
    // The folded later bucket: weeks 2-4 plus later = 130,000 across 4.
    expect(card.textContent).toContain("130,000");
    expect(
      screen.getByTestId("payables-supplier-sp-1").textContent,
    ).toContain("Dangote Cement");
    expect(
      screen.getByTestId("link-view-bills").getAttribute("href"),
    ).toContain("/bills");
  });

  test("no card while the query hasn't succeeded", () => {
    render(<PayablesCard clientPartyId="cp-1" />);
    expect(screen.queryByTestId("card-payables")).toBeNull();
  });

  test("no card for an empty bills book (no groups)", () => {
    harness.summary = { clientPartyId: "cp-1", groups: [], topSuppliers: [] };
    harness.isSuccess = true;
    render(<PayablesCard clientPartyId="cp-1" />);
    expect(screen.queryByTestId("card-payables")).toBeNull();
  });
});
