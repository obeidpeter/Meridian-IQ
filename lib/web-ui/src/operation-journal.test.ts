// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  beginOperation,
  clearCompletedOperations,
  dismissOperation,
  readOperations,
  updateOperation,
} from "./operation-journal";

const KEY = "meridianiq:operations:user-1";

afterEach(() => {
  window.localStorage.clear();
  vi.useRealTimers();
});

describe("operation journal", () => {
  test("records and completes an operation", () => {
    const started = beginOperation(KEY, {
      title: "Invoice import",
      kind: "import",
      route: "/import",
      detail: "12 rows",
    });
    expect(started?.status).toBe("running");
    updateOperation(KEY, started?.id, {
      status: "succeeded",
      savedSummary: "12 drafts created.",
    });
    expect(readOperations(KEY)[0].savedSummary).toBe("12 drafts created.");
    clearCompletedOperations(KEY);
    expect(readOperations(KEY)).toEqual([]);
  });

  test("keeps failures until explicitly dismissed", () => {
    const started = beginOperation(KEY, {
      title: "Client export",
      kind: "export",
      route: "/clients/a",
    });
    updateOperation(KEY, started?.id, {
      status: "failed",
      savedSummary: "No file was saved.",
    });
    clearCompletedOperations(KEY);
    expect(readOperations(KEY)).toHaveLength(1);
    dismissOperation(KEY, started!.id);
    expect(readOperations(KEY)).toEqual([]);
  });

  test("turns an abandoned running record into a review state", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T10:00:00Z"));
    beginOperation(KEY, {
      title: "Stamp invoice",
      kind: "submission",
      route: "/invoices/a",
    });
    vi.setSystemTime(new Date("2026-08-28T11:00:00Z"));
    expect(readOperations(KEY)[0].status).toBe("partial");
  });
});
