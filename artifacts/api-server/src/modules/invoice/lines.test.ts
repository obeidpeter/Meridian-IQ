import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertPlausibleVatRates,
  computeLineFinancials,
  vatRateError,
} from "./lines.ts";
import { DomainError } from "../errors.ts";

// Regression: mobile quick-entry once sent the VAT rate as a percent ("7.5")
// where the API expects a fraction ("0.075"), inflating VAT 100x. The server
// now rejects implausible rates, and this locks in the correct payload shape.

test("quick-entry payload shape: fraction vatRate passes and yields correct VAT math", () => {
  // Mobile quick entry converts a "7.5" percent field to the "0.075" fraction
  // the API expects (String(7.5 / 100)).
  const line = {
    description: "Consulting services",
    quantity: "2",
    unitPrice: "10000",
    vatRate: String(7.5 / 100),
  };
  assert.equal(line.vatRate, "0.075");
  assert.doesNotThrow(() => assertPlausibleVatRates([line]));
  const fin = computeLineFinancials(line);
  assert.equal(fin.lineExtension, "20000.00");
  assert.equal(fin.vatAmount, "1500.00"); // 7.5% of 20,000 — not 150,000
});

test("percent-style vatRate (the original bug) is rejected loudly", () => {
  const line = {
    description: "Consulting services",
    quantity: "2",
    unitPrice: "10000",
    vatRate: "7.5", // percent form — would produce 100x-inflated VAT
  };
  assert.throws(
    () => assertPlausibleVatRates([line]),
    (err: unknown) => {
      assert.ok(err instanceof DomainError);
      assert.equal(err.code, "VAT_RATE_IMPLAUSIBLE");
      assert.equal(err.status, 400);
      assert.match(err.message, /Line 1/);
      assert.match(err.message, /fraction between 0 and 1/);
      return true;
    },
  );
});

test("boundary and invalid values", () => {
  // Valid fractions: zero-rated, standard 7.5%, and 100% (upper bound).
  assert.equal(vatRateError("0"), null);
  assert.equal(vatRateError("0.075"), null);
  assert.equal(vatRateError("1"), null);
  // Implausible or malformed values are rejected.
  assert.notEqual(vatRateError("1.000001"), null);
  assert.notEqual(vatRateError("-0.075"), null);
  assert.notEqual(vatRateError("7.5"), null);
  assert.notEqual(vatRateError("75"), null);
  assert.notEqual(vatRateError("abc"), null);
  assert.notEqual(vatRateError("Infinity"), null);
  assert.notEqual(vatRateError(""), null);
  assert.notEqual(vatRateError("   "), null);
});

test("the failing line is named when a later line is bad", () => {
  const good = {
    description: "ok",
    quantity: "1",
    unitPrice: "100",
    vatRate: "0.075",
  };
  const bad = { ...good, vatRate: "7.5" };
  assert.throws(
    () => assertPlausibleVatRates([good, bad]),
    (err: unknown) => {
      assert.ok(err instanceof DomainError);
      assert.match(err.message, /Line 2/);
      return true;
    },
  );
});
