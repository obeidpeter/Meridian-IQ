import { test } from "node:test";
import assert from "node:assert/strict";
import { fieldMatches, valuesMatch } from "./eval-scoring.ts";

test("numeric extraction scoring tolerates display formatting only", () => {
  assert.equal(fieldMatches("grandTotal", "215000.00", "215,000"), true);
  assert.equal(fieldMatches("grandTotal", "215000", "215000.004"), true);
  assert.equal(fieldMatches("grandTotal", "215000", "215000.01"), false);
});

test("text extraction scoring is trim- and case-insensitive", () => {
  assert.equal(
    fieldMatches(
      "supplierName",
      "Adekunle Textiles Ltd",
      "  ADEKUNLE TEXTILES LTD ",
    ),
    true,
  );
});

test("blank and null values match without treating hallucinations as correct", () => {
  assert.equal(valuesMatch(false, null, ""), true);
  assert.equal(valuesMatch(false, null, "invented"), false);
  assert.equal(valuesMatch(false, "expected", null), false);
});

test("non-numeric fields never coerce numeric-looking text", () => {
  assert.equal(valuesMatch(false, "1,000", "1000"), false);
});
