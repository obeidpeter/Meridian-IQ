import { test } from "node:test";
import assert from "node:assert/strict";
import {
  apiErrorMessage,
  errorStatus,
  serverFieldErrors,
  serverMessage,
} from "./api-error.ts";

test("friendly display text leaves raw classifiers and field errors unchanged", () => {
  const errors = [{ field: "invoiceNumber", message: "Already used" }];
  const error = { status: 403, data: { message: "Forbidden", errors } };
  assert.equal(
    apiErrorMessage(error, "Fallback"),
    "Your account does not have permission to do this.",
  );
  assert.equal(serverMessage(error), "Forbidden");
  assert.equal(errorStatus(error), 403);
  assert.equal(serverFieldErrors(error), errors);
});

test("display errors keep result uncertainty and domain-specific guidance", () => {
  assert.match(
    apiErrorMessage(new Error("Failed to fetch"), "Fallback"),
    /before Valo could confirm the result/,
  );
  assert.match(
    apiErrorMessage({ data: { error: "Internal server error" } }, "Fallback"),
    /Check the latest status before trying again/,
  );
  assert.equal(
    apiErrorMessage(
      { data: { error: "Compliance consent is required" } },
      "Fallback",
    ),
    "Compliance consent is required",
  );
  assert.equal(apiErrorMessage(null, "Fallback"), "Fallback");
});
