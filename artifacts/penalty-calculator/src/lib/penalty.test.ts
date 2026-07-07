import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calculatePenalty,
  classifyBand,
  section103Penalty,
  section104Penalty,
  SMALL_TURNOVER_CEILING,
  MEDIUM_TURNOVER_CEILING,
  type PenaltyInput,
  type PenaltyResult,
} from "./penalty.ts";

/**
 * Hand-calculated fixtures. Each `total` is worked out by hand from the
 * published model:
 *   s.103 = days <= 0 ? 0 : 1_000_000 + 10_000 * (days - 1)
 *   s.104 = count * { small 25_000, medium 50_000, large 100_000 }[band]
 */
const FIXTURES: Array<{
  name: string;
  input: PenaltyInput;
  expected: PenaltyResult;
}> = [
  {
    name: "no exposure",
    input: { annualTurnover: 10_000_000, daysAccessNotGranted: 0, nonCompliantInvoiceCount: 0 },
    expected: { band: "small", section103: 0, section104: 0, total: 0 },
  },
  {
    name: "small — 1 day, 3 invoices",
    input: { annualTurnover: 10_000_000, daysAccessNotGranted: 1, nonCompliantInvoiceCount: 3 },
    // s103 = 1_000_000 ; s104 = 3 * 25_000 = 75_000 ; total = 1_075_000
    expected: { band: "small", section103: 1_000_000, section104: 75_000, total: 1_075_000 },
  },
  {
    name: "medium — 5 days, 10 invoices",
    input: { annualTurnover: 60_000_000, daysAccessNotGranted: 5, nonCompliantInvoiceCount: 10 },
    // s103 = 1_000_000 + 10_000*4 = 1_040_000 ; s104 = 10 * 50_000 = 500_000 ; total = 1_540_000
    expected: { band: "medium", section103: 1_040_000, section104: 500_000, total: 1_540_000 },
  },
  {
    name: "large — 30 days, 100 invoices",
    input: { annualTurnover: 500_000_000, daysAccessNotGranted: 30, nonCompliantInvoiceCount: 100 },
    // s103 = 1_000_000 + 10_000*29 = 1_290_000 ; s104 = 100 * 100_000 = 10_000_000 ; total = 11_290_000
    expected: { band: "large", section103: 1_290_000, section104: 10_000_000, total: 11_290_000 },
  },
  {
    name: "band boundary — exactly small ceiling is small",
    input: { annualTurnover: SMALL_TURNOVER_CEILING, daysAccessNotGranted: 0, nonCompliantInvoiceCount: 1 },
    expected: { band: "small", section103: 0, section104: 25_000, total: 25_000 },
  },
  {
    name: "band boundary — one Naira over small ceiling is medium",
    input: { annualTurnover: SMALL_TURNOVER_CEILING + 1, daysAccessNotGranted: 0, nonCompliantInvoiceCount: 1 },
    expected: { band: "medium", section103: 0, section104: 50_000, total: 50_000 },
  },
  {
    name: "band boundary — exactly medium ceiling is medium",
    input: { annualTurnover: MEDIUM_TURNOVER_CEILING, daysAccessNotGranted: 0, nonCompliantInvoiceCount: 1 },
    expected: { band: "medium", section103: 0, section104: 50_000, total: 50_000 },
  },
  {
    name: "band boundary — one Naira over medium ceiling is large",
    input: { annualTurnover: MEDIUM_TURNOVER_CEILING + 1, daysAccessNotGranted: 0, nonCompliantInvoiceCount: 1 },
    expected: { band: "large", section103: 0, section104: 100_000, total: 100_000 },
  },
];

for (const fixture of FIXTURES) {
  test(`calculatePenalty: ${fixture.name}`, () => {
    assert.deepEqual(calculatePenalty(fixture.input), fixture.expected);
  });
}

test("classifyBand thresholds", () => {
  assert.equal(classifyBand(0), "small");
  assert.equal(classifyBand(25_000_000), "small");
  assert.equal(classifyBand(25_000_001), "medium");
  assert.equal(classifyBand(100_000_000), "medium");
  assert.equal(classifyBand(100_000_001), "large");
});

test("section103Penalty progression", () => {
  assert.equal(section103Penalty(0), 0);
  assert.equal(section103Penalty(1), 1_000_000);
  assert.equal(section103Penalty(2), 1_010_000);
  assert.equal(section103Penalty(10), 1_090_000);
});

test("section104Penalty scales with band", () => {
  assert.equal(section104Penalty(0, "large"), 0);
  assert.equal(section104Penalty(4, "small"), 100_000);
  assert.equal(section104Penalty(4, "medium"), 200_000);
  assert.equal(section104Penalty(4, "large"), 400_000);
});

test("inputs are sanitised: negatives, fractions and NaN are neutralised", () => {
  assert.deepEqual(
    calculatePenalty({ annualTurnover: -5, daysAccessNotGranted: -3, nonCompliantInvoiceCount: -1 }),
    { band: "small", section103: 0, section104: 0, total: 0 },
  );
  // Fractional days/invoices floor to whole units.
  assert.equal(section103Penalty(2.9), 1_010_000);
  assert.equal(section104Penalty(3.9, "small"), 75_000);
  assert.equal(classifyBand(Number.NaN), "small");
});
