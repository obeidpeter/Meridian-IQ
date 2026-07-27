import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays, daysBetween, median } from "./date-math.ts";

// Pure helpers shared by the history miners — pinned here once instead of
// per copy: calendar-day arithmetic across month/year boundaries, signed
// distances, and the even/odd median convention.

test("addDays walks the calendar, across month and year boundaries", () => {
  assert.equal(addDays("2026-06-01", 14), "2026-06-15");
  assert.equal(addDays("2026-01-31", 1), "2026-02-01");
  assert.equal(addDays("2026-12-30", 5), "2027-01-04");
  assert.equal(addDays("2026-03-05", -10), "2026-02-23");
  // Leap day.
  assert.equal(addDays("2024-02-28", 1), "2024-02-29");
});

test("daysBetween is signed: positive when b is after a", () => {
  assert.equal(daysBetween("2026-06-01", "2026-06-15"), 14);
  assert.equal(daysBetween("2026-06-15", "2026-06-01"), -14);
  assert.equal(daysBetween("2026-06-01", "2026-06-01"), 0);
  assert.equal(daysBetween("2025-12-25", "2026-01-05"), 11);
});

test("median: middle value when odd, mean of the middle pair when even", () => {
  assert.equal(median([3]), 3);
  assert.equal(median([9, 1, 5]), 5);
  assert.equal(median([1, 2, 3, 10]), 2.5);
  // Input is not mutated.
  const values = [30, 10, 20];
  median(values);
  assert.deepEqual(values, [30, 10, 20]);
});
