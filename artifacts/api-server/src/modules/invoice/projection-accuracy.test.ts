import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeProjectionAccuracy } from "./projection-accuracy.ts";
import type { SettlementEvidenceRow } from "./payment-behaviour.ts";

// Projection accuracy (round-14 idea #2). The evaluation is pure over the
// shared settlement-evidence rows (acceptedSettlementRows — the SAME query
// the behaviour miner uses, exercised by its own DB-backed tests), so these
// tests pin the replay logic itself:
//  - the three-tier rule mirrors the cashflow projection (rhythm > due date
//    > 30-day default);
//  - the rhythm tier is leave-one-out: a payment never predicts itself, and
//    a buyer needs 3+ OTHER settlements before rhythm applies;
//  - error is signed (positive = later than projected);
//  - negatives (credit before invoice) are dropped as non-evidence.

function row(
  buyer: string,
  daysToPay: number,
  opts: { issueDate?: string; dueDate?: string | null } = {},
): SettlementEvidenceRow {
  const issueDate = opts.issueDate ?? "2026-05-01";
  const value = new Date(`${issueDate}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + daysToPay);
  return {
    buyerPartyId: buyer,
    buyerName: `Buyer ${buyer}`,
    issueDate,
    dueDate: opts.dueDate === undefined ? null : opts.dueDate,
    valueDate: value.toISOString().slice(0, 10),
    daysToPay,
  };
}

test("rhythm tier is leave-one-out over the buyer's other settlements", () => {
  // Buyer A pays at 10, 10, 10, 30: the 30 is judged against median(10,10,10)
  // = 10 → error +20; each 10 is judged against median(10,10,30) = 10 → 0.
  const report = summarizeProjectionAccuracy(
    [row("A", 10), row("A", 10), row("A", 10), row("A", 30)],
    "2026-07-17",
  );
  assert.equal(report.settlements, 4);
  assert.equal(report.basisSplit.rhythm, 4);
  assert.equal(report.medianErrorDays, 0);
  assert.equal(report.medianAbsErrorDays, 0);
  assert.equal(report.withinShare, 0.75, "the +20 outlier is outside ±7");
  const buyer = report.buyers.find((b) => b.buyerPartyId === "A");
  assert.ok(buyer);
  assert.equal(buyer.settlements, 4);
  assert.equal(buyer.medianErrorDays, 0);
});

test("too few settlements fall to due-date terms, then the 30-day default", () => {
  // Two settlements each — below the 3-other floor, so rhythm never applies.
  const report = summarizeProjectionAccuracy(
    [
      // Due 14 days after issue; paid at 20 → error +6.
      row("B", 20, { dueDate: "2026-05-15" }),
      // No due date; paid at 25 → judged against 30 → error −5.
      row("B", 25),
      // Buyer C: one settlement, no due date, paid at 37 → +7.
      row("C", 37),
    ],
    "2026-07-17",
  );
  assert.equal(report.settlements, 3);
  assert.equal(report.basisSplit.rhythm, 0);
  assert.equal(report.basisSplit.dueDate, 1);
  assert.equal(report.basisSplit.defaultTerms, 2);
  assert.equal(report.medianErrorDays, 6);
  assert.equal(report.withinShare, 1, "all three inside ±7");
  // Under 3 settlements per buyer → no per-buyer rows.
  assert.equal(report.buyers.length, 0);
});

test("negative days-to-pay are dropped; empty evidence answers with nulls", () => {
  const report = summarizeProjectionAccuracy([row("D", -3)], "2026-07-17");
  assert.equal(report.settlements, 0);
  assert.equal(report.medianErrorDays, null);
  assert.equal(report.medianAbsErrorDays, null);
  assert.equal(report.withinShare, null);
  assert.equal(report.buyers.length, 0);
  assert.match(report.note, /exclude the payment being predicted/i);
});
