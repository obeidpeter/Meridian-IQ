import { test, expect, describe } from "vitest";
import { errorStatus, isFeatureDisabled, serverErrorMessage } from "./errors";

describe("errorStatus", () => {
  test("reads a numeric status off an ApiError-shaped object", () => {
    expect(errorStatus({ status: 404 })).toBe(404);
    expect(errorStatus({ status: 403, data: {} })).toBe(403);
  });

  test("returns undefined when there is no numeric status", () => {
    expect(errorStatus({ status: "404" })).toBeUndefined();
    expect(errorStatus({})).toBeUndefined();
    expect(errorStatus(null)).toBeUndefined();
    expect(errorStatus(new Error("boom"))).toBeUndefined();
  });
});

describe("isFeatureDisabled", () => {
  test("is true only for a 404 (dark feature flag)", () => {
    expect(isFeatureDisabled({ status: 404 })).toBe(true);
    expect(isFeatureDisabled({ status: 403 })).toBe(false);
    expect(isFeatureDisabled(new Error("boom"))).toBe(false);
    expect(isFeatureDisabled(null)).toBe(false);
  });
});

describe("serverErrorMessage", () => {
  test("prefers the server's { data: { error } } body message", () => {
    expect(serverErrorMessage({ data: { error: "consent required" } })).toBe(
      "consent required",
    );
  });

  test("falls back to an Error's message when there is no server body", () => {
    expect(serverErrorMessage(new Error("network down"))).toBe("network down");
  });

  test("uses the generic fallback for non-string bodies and plain values", () => {
    expect(serverErrorMessage({ data: { error: 42 } })).toBe("Please try again.");
    expect(serverErrorMessage({ data: {} })).toBe("Please try again.");
    expect(serverErrorMessage("just a string")).toBe("Please try again.");
    expect(serverErrorMessage(null)).toBe("Please try again.");
  });
});
