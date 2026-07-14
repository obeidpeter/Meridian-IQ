import { test, expect, describe } from "vitest";
import {
  errorStatus,
  isFeatureDisabled,
  isForbidden,
  killSwitchTripped,
  serverErrorMessage,
} from "./errors";

describe("errorStatus", () => {
  test("reads a numeric status off an ApiError-shaped object", () => {
    expect(errorStatus({ status: 404 })).toBe(404);
    expect(errorStatus({ status: 403, data: {} })).toBe(403);
    expect(errorStatus({ status: 503 })).toBe(503);
  });

  test("returns undefined when there is no numeric status", () => {
    // A string status is not a number — the duck-type guard rejects it.
    expect(errorStatus({ status: "404" })).toBeUndefined();
    expect(errorStatus({})).toBeUndefined();
    expect(errorStatus(null)).toBeUndefined();
    expect(errorStatus(undefined)).toBeUndefined();
    // A plain Error carries no status field.
    expect(errorStatus(new Error("boom"))).toBeUndefined();
  });
});

describe("isFeatureDisabled", () => {
  test("is true only for a 404 (dark feature flag)", () => {
    expect(isFeatureDisabled({ status: 404 })).toBe(true);
    expect(isFeatureDisabled({ status: 403 })).toBe(false);
    expect(isFeatureDisabled({ status: 503 })).toBe(false);
    expect(isFeatureDisabled(new Error("boom"))).toBe(false);
    expect(isFeatureDisabled(null)).toBe(false);
  });
});

describe("isForbidden", () => {
  test("is true only for a 403 (non-operator principal)", () => {
    expect(isForbidden({ status: 403 })).toBe(true);
    expect(isForbidden({ status: 404 })).toBe(false);
    expect(isForbidden({ status: 503 })).toBe(false);
    expect(isForbidden(null)).toBe(false);
  });
});

describe("killSwitchTripped", () => {
  test("is true only for a 503 (clerk_ai kill switch off)", () => {
    expect(killSwitchTripped({ status: 503 })).toBe(true);
    expect(killSwitchTripped({ status: 500 })).toBe(false);
    expect(killSwitchTripped({ status: 404 })).toBe(false);
    expect(killSwitchTripped(null)).toBe(false);
  });
});

describe("serverErrorMessage", () => {
  test("returns the server's { data: { error } } body message when it is a string", () => {
    expect(serverErrorMessage({ data: { error: "consent required" } })).toBe(
      "consent required",
    );
    // An empty string is still a string, so it passes through verbatim.
    expect(serverErrorMessage({ data: { error: "" } })).toBe("");
  });

  test("returns undefined for non-string bodies, missing bodies, and plain values", () => {
    // Unlike the SME app, this helper has NO generic fallback string — a
    // non-string / absent server error yields undefined.
    expect(serverErrorMessage({ data: { error: 42 } })).toBeUndefined();
    expect(serverErrorMessage({ data: {} })).toBeUndefined();
    expect(serverErrorMessage({})).toBeUndefined();
    expect(serverErrorMessage("just a string")).toBeUndefined();
    expect(serverErrorMessage(null)).toBeUndefined();
    // It does not read Error.message — only the server's data.error body.
    expect(serverErrorMessage(new Error("network down"))).toBeUndefined();
  });
});
