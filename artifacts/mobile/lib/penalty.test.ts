import { test } from "node:test";
import assert from "node:assert/strict";
import {
  S103_FIRST_DAY,
  S103_PER_ADDITIONAL_DAY,
  S104_PER_INVOICE,
  section103Penalty,
  section104Penalty,
} from "./penalty.ts";

// PARITY PIN — this module is a port of the public penalty calculator's
// statutory model (`artifacts/penalty-calculator/src/lib/penalty.ts`, tested
// in `artifacts/penalty-calculator/src/lib/penalty.test.ts`). The constants
// and the section103/section104 outputs below are copied verbatim from that
// suite's fixtures, so a change to the published model on one side fails the
// other side's test and points at it. Change one, change both.

test("statutory constants match the calculator's published model", () => {
  assert.equal(S103_FIRST_DAY, 1_000_000);
  assert.equal(S103_PER_ADDITIONAL_DAY, 10_000);
  assert.deepEqual(S104_PER_INVOICE, {
    small: 25_000,
    medium: 50_000,
    large: 100_000,
  });
});

test("section103Penalty progression", () => {
  assert.equal(section103Penalty(0), 0);
  assert.equal(section103Penalty(1), 1_000_000);
  assert.equal(section103Penalty(2), 1_010_000);
  assert.equal(section103Penalty(10), 1_090_000);
  assert.equal(section103Penalty(30), 1_290_000);
});

test("section104Penalty scales with band", () => {
  assert.equal(section104Penalty(0, "large"), 0);
  assert.equal(section104Penalty(4, "small"), 100_000);
  assert.equal(section104Penalty(4, "medium"), 200_000);
  assert.equal(section104Penalty(4, "large"), 400_000);
});

test("inputs are sanitised: negatives, fractions and NaN are neutralised", () => {
  assert.equal(section103Penalty(-3), 0);
  assert.equal(section103Penalty(2.9), 1_010_000);
  assert.equal(section104Penalty(-1, "small"), 0);
  assert.equal(section104Penalty(3.9, "small"), 75_000);
});
