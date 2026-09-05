// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import {
  isDefinitiveFirstRejection,
  readInvoiceSubmission,
  submissionStorageKey,
} from "./invoice-submission";

afterEach(() => localStorage.clear());

test.each([undefined, 0, 200, 401, 403, 404, 408, 409, 429, 500, 503])(
  "status %s is not proof a first request was rejected before execution",
  (status) => {
    expect(
      isDefinitiveFirstRejection({ status, data: { error: "Failure" } }),
    ).toBe(false);
  },
);
test.each([400, 422])(
  "only a structured first-attempt %s rejection permits correction",
  (status) => {
    expect(isDefinitiveFirstRejection({ status })).toBe(false);
    expect(
      isDefinitiveFirstRejection({ status, data: { error: "Invalid input" } }),
    ).toBe(true);
  },
);
test("corrupt original request is blocked instead of discarded or given a new key", () => {
  localStorage.setItem(submissionStorageKey("scope", "id"), "broken");
  expect(readInvoiceSubmission("scope", "id")).toEqual({
    status: "blocked",
    key: "invoice-create:id",
  });
  expect(localStorage.getItem(submissionStorageKey("scope", "id"))).toBe(
    "broken",
  );
});
