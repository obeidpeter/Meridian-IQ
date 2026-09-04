import test from "node:test";
import assert from "node:assert/strict";
import { invoiceNgnEquivalent } from "./ngn-equivalent.ts";

test("invoice export preserves large cents and rounds FX using decimal half-up", () => {
  assert.equal(
    invoiceNgnEquivalent({
      currency: "USD",
      grandTotal: "99999999999999.99",
      fxRateToNgn: "1",
    }),
    "99999999999999.99",
  );
  assert.equal(
    invoiceNgnEquivalent({
      currency: "USD",
      grandTotal: "1.00",
      fxRateToNgn: "1.005",
    }),
    "1.01",
  );
  assert.equal(
    invoiceNgnEquivalent({
      currency: "NGN",
      grandTotal: "42.00",
      fxRateToNgn: null,
    }),
    "42.00",
  );
  for (const rate of [null, "0", "NaN"]) {
    assert.equal(
      invoiceNgnEquivalent({
        currency: "USD",
        grandTotal: "42.00",
        fxRateToNgn: rate,
      }),
      "",
    );
  }
});
