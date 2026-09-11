import assert from "node:assert/strict";
import { test } from "vitest";
import { errorStatus, serverError, userErrorMessage } from "./index";

test("friendly error text does not change machine-readable classification", () => {
  const error = { status: 500, data: { error: "Internal server error" } };
  assert.equal(errorStatus(error), 500);
  assert.equal(serverError(error), "Internal server error");
  assert.match(userErrorMessage(error)!, /Check the latest status/);
});

test("network and timeout messages preserve uncertainty about saved work", () => {
  for (const message of [
    "Failed to fetch",
    "Network Error",
    "Network request failed",
    "Request timed out",
  ]) {
    const text = userErrorMessage(new Error(message))!;
    assert.match(text, /confirm/);
    assert.match(text, /latest status before trying again/);
    assert.doesNotMatch(text, /nothing was saved|no changes were made/i);
  }
});

test("specific server instructions and support references remain intact", () => {
  const message =
    "Invoice INV-2041 changed. Review the latest version. Reference ABC-123.";
  assert.equal(userErrorMessage({ data: { error: message } }), message);
  assert.equal(userErrorMessage(new Error(message)), message);
  assert.equal(userErrorMessage(null), undefined);
  assert.equal(userErrorMessage({ data: { error: {} } }), undefined);
  assert.equal(userErrorMessage(new Error("constructor")), "constructor");
  assert.equal(userErrorMessage(new Error("toString")), "toString");
});

test("access errors give a clear next step without changing permission checks", () => {
  assert.equal(
    userErrorMessage({ data: { error: "Unauthorized" } }),
    "Please sign in again to continue.",
  );
  assert.equal(
    userErrorMessage({ data: { error: "Forbidden" } }),
    "Your account does not have permission to do this.",
  );
});
