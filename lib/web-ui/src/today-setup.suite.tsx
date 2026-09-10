// R113: a failed refresh must never present the cached setup checklist as
// confirmed. The page hands the query's error, in-flight state and retry to
// the shared workspace, whose setup panel then reports unavailable (or
// loading) instead of the last percentage. The console and SME Today pages
// hand the same query to the same workspace, so their suites were
// byte-identical: this is the one suite both apps run, and each app keeps
// only its module mocks (web-ui cannot resolve @workspace/api-client-react).
// Not a test file itself: nothing runs unless an app calls
// runTodaySetupSuite.
import { afterEach, beforeEach, expect, test, vi, type Mock } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentType } from "react";

// The mocked useGetWorkspaceToday payload: one complete setup step, so a
// successful read shows 100%.
export const todaySetupFixture = {
  summary: { total: 0, urgent: 0, dueSoon: 0, blocked: 0 },
  items: [],
  setup: [
    {
      id: "business_identity",
      label: "Confirm business details",
      description: "Legal name, TIN and address on record.",
      complete: true,
      href: "/business",
    },
  ],
  generatedAt: "2026-09-09T08:00:00Z",
};

export interface TodaySetupHarness {
  error: Error | null;
  isFetching: boolean;
  refetch: Mock;
}

export function runTodaySetupSuite({
  Today,
  harness: h,
}: {
  Today: ComponentType;
  harness: TodaySetupHarness;
}): void {
  beforeEach(() => {
    vi.clearAllMocks();
    h.error = null;
    h.isFetching = false;
  });
  afterEach(cleanup);

  test("a successful read shows the confirmed setup percentage", () => {
    render(<Today />);
    expect(screen.queryByText(/Setup progress is unavailable/)).toBeNull();
    expect(screen.getAllByText("100%").length).toBeGreaterThan(0);
  });

  test("a failed refresh reports setup unavailable, hides the cached percentage and retries the query", () => {
    h.error = new Error("offline");
    render(<Today />);
    expect(screen.getByText(/Setup progress is unavailable/)).toBeTruthy();
    expect(screen.queryAllByText("100%")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Retry setup" }));
    expect(h.refetch).toHaveBeenCalledOnce();
  });

  test("a retry in flight after a failure keeps the retry control busy rather than showing a stale result", () => {
    h.error = new Error("offline");
    h.isFetching = true;
    render(<Today />);
    // The unavailable notice and its retry stay mounted while the refetch
    // runs (R115); the heading and the live region report the check.
    expect(screen.getByText(/Setup progress is unavailable/)).toBeTruthy();
    expect(screen.getByText("Checking setup records")).toBeTruthy();
    const retry = screen.getByRole("button", { name: "Retry setup" });
    expect(retry.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(retry);
    expect(h.refetch).not.toHaveBeenCalled();
    expect(screen.queryAllByText("100%")).toHaveLength(0);
  });
}
