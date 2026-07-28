import { test } from "node:test";
import assert from "node:assert/strict";
import { mergePosition } from "./net-position.ts";

// Net cash position (round-15 idea #2). The merge is pure over the two
// sides' already-bucketed groups — these tests pin the alignment rules:
// weeks pair by index, missing sides read as zero, squeeze = outflow >
// inflow, and overdue/later money stays out of the weekly nets.

const bucket = (amount: string, count: number) => ({ amount, count });

test("weeks align by index; net and squeeze are per-week", () => {
  const groups = mergePosition(
    [
      {
        currency: "NGN",
        overdueExpected: bucket("500.00", 1),
        weeks: [
          { startDate: "x", amount: "1000.00", count: 2 },
          { startDate: "x", amount: "100.00", count: 1 },
          { startDate: "x", amount: "0.00", count: 0 },
          { startDate: "x", amount: "0.00", count: 0 },
        ],
        later: bucket("50.00", 1),
        total: bucket("1650.00", 5),
      },
    ],
    [
      {
        currency: "NGN",
        overdue: bucket("200.00", 1),
        dueWeeks: [
          { startDate: "x", amount: "300.00", count: 1 },
          { startDate: "x", amount: "400.00", count: 2 },
          { startDate: "x", amount: "0.00", count: 0 },
          { startDate: "x", amount: "0.00", count: 0 },
        ],
        later: bucket("75.00", 1),
        total: bucket("975.00", 5),
      },
    ],
    "2026-07-17",
  );
  assert.equal(groups.length, 1);
  const g = groups[0];
  assert.equal(g.weeks[0].startDate, "2026-07-17");
  assert.equal(g.weeks[1].startDate, "2026-07-24");
  assert.equal(g.weeks[0].net, "700.00");
  assert.equal(g.weeks[0].squeeze, false);
  assert.equal(g.weeks[1].net, "-300.00");
  assert.equal(g.weeks[1].squeeze, true, "outflow exceeds inflow");
  assert.equal(g.squeezeWeeks, 1);
  assert.equal(g.overdueInflow.amount, "500.00");
  assert.equal(g.overdueOutflow.amount, "200.00");
  assert.equal(g.laterInflow.amount, "50.00");
  assert.equal(g.laterOutflow.amount, "75.00");
});

test("a currency present on only one side reads zero on the other", () => {
  const groups = mergePosition(
    [],
    [
      {
        currency: "USD",
        overdue: bucket("0.00", 0),
        dueWeeks: [
          { startDate: "x", amount: "80.00", count: 1 },
          { startDate: "x", amount: "0.00", count: 0 },
          { startDate: "x", amount: "0.00", count: 0 },
          { startDate: "x", amount: "0.00", count: 0 },
        ],
        later: bucket("0.00", 0),
        total: bucket("80.00", 1),
      },
    ],
    "2026-07-17",
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0].weeks[0].inflow, "0.00");
  assert.equal(groups[0].weeks[0].outflow, "80.00");
  assert.equal(groups[0].weeks[0].squeeze, true);
  assert.equal(groups[0].overdueInflow.count, 0);
});
