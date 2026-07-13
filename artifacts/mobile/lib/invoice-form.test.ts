import { test } from "node:test";
import assert from "node:assert/strict";
import {
  num,
  parseNumeric,
  isValidISODate,
  computeTotals,
  normalizeLines,
  type LineDraft,
} from "./invoice-form.ts";

// The pure form math behind the create-invoice and fix-invoice screens. The
// payload-shape tests pin the percent→fraction conversion that once shipped
// a 100x-inflated VAT rate to the API.

const line = (overrides: Partial<LineDraft>): LineDraft => ({
  key: "k1",
  description: "Goods",
  quantity: "1",
  unitPrice: "100",
  vatRate: "7.5",
  ...overrides,
});

test("num coerces display strings, mapping anything non-finite to 0", () => {
  assert.equal(num("5"), 5);
  assert.equal(num("1.5"), 1.5);
  assert.equal(num(""), 0); // Number("") is 0 — blank fields read as zero
  assert.equal(num("abc"), 0);
  assert.equal(num("-2"), -2);
});

test("parseNumeric trims, accepts a decimal comma, and rejects junk as null", () => {
  assert.equal(parseNumeric(" 7.5 "), 7.5);
  assert.equal(parseNumeric("7,5"), 7.5);
  assert.equal(parseNumeric("-3"), -3);
  assert.equal(parseNumeric(""), null);
  assert.equal(parseNumeric("   "), null);
  assert.equal(parseNumeric("abc"), null);
  // Only a decimal comma is coerced; a thousands separator stays invalid.
  assert.equal(parseNumeric("1,234.5"), null);
});

test("isValidISODate validates real calendar dates, not just the shape", () => {
  assert.equal(isValidISODate("2026-07-13"), true);
  assert.equal(isValidISODate("2028-02-29"), true); // leap year
  assert.equal(isValidISODate("2026-02-29"), false); // not a leap year
  assert.equal(isValidISODate("2026-02-31"), false);
  assert.equal(isValidISODate("2026-13-01"), false);
  assert.equal(isValidISODate("2026-1-01"), false); // must be zero-padded
  assert.equal(isValidISODate(""), false);
});

test("computeTotals treats vatRate as a percent and sums across lines", () => {
  const { subtotal, vat, grand } = computeTotals([
    line({ quantity: "2", unitPrice: "1500", vatRate: "7.5" }),
    line({ key: "k2", quantity: "1", unitPrice: "1000", vatRate: "0" }),
  ]);
  assert.equal(subtotal, 4000);
  assert.equal(vat, 225);
  assert.equal(grand, 4225);
});

test("computeTotals reads blank fields as zero", () => {
  assert.deepEqual(
    computeTotals([line({ quantity: "", unitPrice: "", vatRate: "" })]),
    { subtotal: 0, vat: 0, grand: 0 },
  );
});

test("normalizeLines converts the percent field to the API's fraction", () => {
  const { payloadLines, lineErrs } = normalizeLines([
    line({ description: "  Consulting  ", quantity: "2", unitPrice: "1500", vatRate: "7.5" }),
  ]);
  assert.deepEqual(lineErrs, {});
  assert.deepEqual(payloadLines, [
    {
      description: "Consulting",
      quantity: "2",
      unitPrice: "1500",
      vatRate: "0.075", // fraction, never percent — the original mobile bug
    },
  ]);
});

test("normalizeLines drops lines with a blank description", () => {
  const { payloadLines, lineErrs } = normalizeLines([
    line({ description: "   ", quantity: "0", unitPrice: "-1" }),
  ]);
  assert.deepEqual(payloadLines, []);
  // A dropped line contributes no errors either — it does not exist.
  assert.deepEqual(lineErrs, {});
});

test("normalizeLines flags non-positive quantity and negative price per line", () => {
  const { payloadLines, lineErrs } = normalizeLines([
    line({ key: "bad-qty", quantity: "0" }),
    line({ key: "bad-price", unitPrice: "-1" }),
    line({ key: "bad-both", quantity: "abc", unitPrice: "junk" }),
    line({ key: "ok", quantity: "1,5", vatRate: "" }),
  ]);
  assert.equal(lineErrs["bad-qty"]?.quantity, "Enter a quantity greater than 0.");
  assert.equal(lineErrs["bad-qty"]?.unitPrice, undefined);
  assert.equal(lineErrs["bad-price"]?.unitPrice, "Enter a valid unit price.");
  assert.equal(lineErrs["bad-price"]?.quantity, undefined);
  assert.ok(lineErrs["bad-both"]?.quantity && lineErrs["bad-both"]?.unitPrice);
  assert.equal(lineErrs["ok"], undefined);

  // Every kept line yields exactly one payload entry, unparseable numerics
  // serialize as "0", the decimal comma is honored, and a blank rate is 0.
  assert.equal(payloadLines.length, 4);
  assert.equal(payloadLines[2].quantity, "0");
  assert.equal(payloadLines[2].unitPrice, "0");
  assert.deepEqual(payloadLines[3], {
    description: "Goods",
    quantity: "1.5",
    unitPrice: "100",
    vatRate: "0",
  });
});
