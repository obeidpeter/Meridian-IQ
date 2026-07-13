import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLinesWithTotals } from "./line-totals.ts";
import { money } from "./lines.ts";

// The invariant this module exists for: invoice totals accumulate from the
// ROUNDED per-line strings (what gets persisted and shown), never from raw
// qty*price — the two disagree by cents on edge inputs, and the persisted
// lines must always sum to the persisted totals.

test("plain line: extension, VAT, lineNo and grand total", () => {
  const { computed, subtotal, vatTotal, grandTotal } = computeLinesWithTotals([
    { description: "Goods", quantity: "2", unitPrice: "1500", vatRate: "0.075" },
  ]);
  assert.equal(computed.length, 1);
  assert.equal(computed[0].lineNo, 1);
  assert.equal(computed[0].lineExtension, "3000.00");
  assert.equal(computed[0].vatAmount, "225.00");
  // Input fields ride along untouched for the insert-row mapping.
  assert.equal(computed[0].description, "Goods");
  assert.equal(computed[0].vatRate, "0.075");
  assert.equal(subtotal, 3000);
  assert.equal(vatTotal, 225);
  assert.equal(grandTotal, 3225);
});

test("subtotal sums the rounded line extensions, not the raw products", () => {
  // Each raw extension is 0.126, rounding to "0.13". Summing the rounded
  // strings gives 0.26; summing raw first would give 0.252 → "0.25".
  const { computed, subtotal } = computeLinesWithTotals([
    { description: "A", quantity: "1", unitPrice: "0.126", vatRate: "0" },
    { description: "B", quantity: "1", unitPrice: "0.126", vatRate: "0" },
  ]);
  assert.equal(computed[0].lineExtension, "0.13");
  assert.equal(computed[1].lineExtension, "0.13");
  assert.equal(money(subtotal), "0.26");
});

test("vatTotal sums the rounded per-line VAT, not the raw products", () => {
  // Per-line VAT is 0.033 → "0.03". Three lines: 0.09 from rounded strings;
  // raw-first would give 0.099 → "0.10".
  const lines = Array.from({ length: 3 }, (_, i) => ({
    description: `L${i}`,
    quantity: "1",
    unitPrice: "1.00",
    vatRate: "0.033",
  }));
  const { computed, vatTotal } = computeLinesWithTotals(lines);
  for (const line of computed) assert.equal(line.vatAmount, "0.03");
  assert.equal(money(vatTotal), "0.09");
});

test("lineNo is 1-based and sequential in input order", () => {
  const { computed } = computeLinesWithTotals([
    { description: "first", quantity: "1", unitPrice: "1", vatRate: "0" },
    { description: "second", quantity: "1", unitPrice: "1", vatRate: "0" },
    { description: "third", quantity: "1", unitPrice: "1", vatRate: "0" },
  ]);
  assert.deepEqual(
    computed.map((l) => [l.lineNo, l.description]),
    [
      [1, "first"],
      [2, "second"],
      [3, "third"],
    ],
  );
});

test("grand total is exactly subtotal plus VAT; empty input is all zeros", () => {
  const some = computeLinesWithTotals([
    { description: "X", quantity: "3", unitPrice: "9.99", vatRate: "0.075" },
    { description: "Y", quantity: "1", unitPrice: "0.01", vatRate: "0" },
  ]);
  assert.equal(some.grandTotal, some.subtotal + some.vatTotal);

  const none = computeLinesWithTotals([]);
  assert.deepEqual(none, {
    computed: [],
    subtotal: 0,
    vatTotal: 0,
    grandTotal: 0,
  });
});
