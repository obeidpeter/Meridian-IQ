import { describe, expect, test } from "vitest";
import {
  clerkBudgetExhausted,
  errorStatus,
  isFeatureDisabled,
  isForbidden,
  killSwitchTripped,
  serverError,
} from "./index";

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

describe("status predicates", () => {
  test("isFeatureDisabled is true only for 404 (dark feature flag)", () => {
    expect(isFeatureDisabled({ status: 404 })).toBe(true);
    expect(isFeatureDisabled({ status: 403 })).toBe(false);
    expect(isFeatureDisabled(null)).toBe(false);
  });

  test("isForbidden is true only for 403", () => {
    expect(isForbidden({ status: 403 })).toBe(true);
    expect(isForbidden({ status: 404 })).toBe(false);
  });

  test("killSwitchTripped is true only for 503 (clerk_ai off)", () => {
    expect(killSwitchTripped({ status: 503 })).toBe(true);
    expect(killSwitchTripped({ status: 429 })).toBe(false);
    expect(killSwitchTripped(new Error("boom"))).toBe(false);
  });

  test("clerkBudgetExhausted is true only for 429 (allowance spent)", () => {
    expect(clerkBudgetExhausted({ status: 429 })).toBe(true);
    expect(clerkBudgetExhausted({ status: 503 })).toBe(false);
  });
});

describe("serverError", () => {
  test("returns the server's { data: { error } } body message", () => {
    expect(serverError({ data: { error: "consent required" } })).toBe(
      "consent required",
    );
  });

  test("returns undefined when the body carries no error string", () => {
    expect(serverError({ data: { error: 42 } })).toBeUndefined();
    expect(serverError({ data: {} })).toBeUndefined();
    expect(serverError({})).toBeUndefined();
    expect(serverError(null)).toBeUndefined();
    expect(serverError(new Error("boom"))).toBeUndefined();
  });
});
