import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePhone } from "./phone.ts";

// The one shared phone normalizer: table-driven, because the inbound
// WhatsApp rail's sender matching depends on every one of these shapes
// resolving identically on both sides of the comparison.

test("normalizePhone: accepted shapes", () => {
  const cases: Array<[string, string]> = [
    // Nigerian local convention: 0XXXXXXXXXX (11 digits) → +234XXXXXXXXXX.
    ["08031234567", "+2348031234567"],
    ["0803 123 4567", "+2348031234567"],
    ["0803-123-4567", "+2348031234567"],
    ["(0803) 123 4567", "+2348031234567"],
    // Already-international forms of the same number.
    ["+2348031234567", "+2348031234567"],
    ["+234 803 123 4567", "+2348031234567"],
    ["+234 (803) 123-4567", "+2348031234567"],
    // Bare digits with a country code pass through unchanged.
    ["2348031234567", "+2348031234567"],
    // Non-Nigerian numbers are fine too — the 0-prefix rule only fires on
    // the exact 11-digit local shape.
    ["+1 212 555 1212", "+12125551212"],
    ["12125551212", "+12125551212"],
    // Length bounds: 8 and 15 digits are the inclusive limits.
    ["12345678", "+12345678"],
    ["+123456789012345", "+123456789012345"],
    // Surrounding whitespace is stripped.
    ["  +234 803 123 4567  ", "+2348031234567"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizePhone(input), expected, `normalizePhone(${JSON.stringify(input)})`);
  }
});

test("normalizePhone: rejected shapes", () => {
  const rejected = [
    "", // empty
    "   ", // whitespace only
    "+", // plus with no digits
    "abc", // not a number
    "0803123456a", // stray letter
    "080312345.67", // dots are not a stripped separator
    "++2348031234567", // double plus
    "234+8031234567", // plus not leading
    "5551212", // 7 digits — too short
    "1234567890123456", // 16 digits — too long
    "+1234567890123456", // 16 digits with plus — too long
  ];
  for (const input of rejected) {
    assert.equal(normalizePhone(input), null, `normalizePhone(${JSON.stringify(input)})`);
  }
});

test("normalizePhone: local and international forms of one number match", () => {
  assert.equal(
    normalizePhone("0803 123 4567"),
    normalizePhone("+234-803-123-4567"),
  );
});
