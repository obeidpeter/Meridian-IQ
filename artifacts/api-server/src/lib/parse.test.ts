import { test } from "node:test";
import assert from "node:assert/strict";
import { DomainError } from "../modules/errors.ts";
import { resolvePaymentFlagAmount } from "./parse.ts";

test("payment flags default to the invoice total", () => {
  assert.equal(
    resolvePaymentFlagAmount("scheduled", undefined, "150.00"),
    "150.00",
  );
  assert.equal(resolvePaymentFlagAmount("paid", undefined, "150.00"), "150.00");
});

test("paid flags reject partial amounts but allow exact and excess payment", () => {
  assert.throws(
    () => resolvePaymentFlagAmount("paid", "149.99", "150.00"),
    (error) =>
      error instanceof DomainError &&
      error.code === "INCOMPLETE_PAYMENT" &&
      error.status === 400,
  );
  assert.equal(resolvePaymentFlagAmount("paid", "150", "150.00"), "150");
  assert.equal(resolvePaymentFlagAmount("paid", "151.00", "150.00"), "151.00");
});

test("scheduled flags may represent a partial amount", () => {
  assert.equal(
    resolvePaymentFlagAmount("scheduled", "25.50", "150.00"),
    "25.50",
  );
});
