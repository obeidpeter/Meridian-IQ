import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isCalendarDate,
  decimalInputError,
  assertLineInputs,
} from "./input-validation.ts";

test("dates are exact calendar dates, not JS-normalized values", () => {
  for (const date of [
    "0000-01-01",
    "2026-02-31",
    "2025-02-29",
    "2026-13-01",
    "2026-1-1",
    "2026-01-01T00:00:00Z",
  ]) {
    assert.equal(isCalendarDate(date), false, date);
  }
  for (const date of ["0001-01-01", "2024-02-29", "2026-12-31"])
    assert.equal(isCalendarDate(date), true, date);
});

test("decimal inputs reject non-finite, exponential and out-of-scale values", () => {
  for (const value of [
    "Infinity",
    "NaN",
    "1e2",
    "-1",
    "1.00001",
    "999999999999999",
  ]) {
    assert.ok(decimalInputError(value, "Quantity", 14, 4, true), value);
  }
  assert.equal(decimalInputError("0.0001", "Quantity", 14, 4, true), null);
  assert.throws(() =>
    assertLineInputs([{ quantity: "1", unitPrice: "1.001" }]),
  );
  assert.doesNotThrow(() =>
    assertLineInputs([{ quantity: "0.5", unitPrice: "2.01" }]),
  );
});
