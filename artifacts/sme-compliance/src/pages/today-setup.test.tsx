// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// R113: a failed refresh must never present the cached setup checklist as
// confirmed. The page hands the query's error, in-flight state and retry to
// the shared workspace, whose setup panel then reports unavailable (or
// loading) instead of the last percentage.
const h = vi.hoisted(() => ({
  error: null as Error | null,
  isFetching: false,
  refetch: vi.fn(),
}));
vi.mock("@workspace/api-client-react", async (original) => ({
  ...(await original<typeof import("@workspace/api-client-react")>()),
  useGetWorkspaceToday: () => ({
    data: {
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
    },
    isLoading: false,
    isFetching: h.isFetching,
    error: h.error,
    refetch: h.refetch,
  }),
}));
vi.mock("@workspace/web-ui", async (original) => ({
  ...(await original<typeof import("@workspace/web-ui")>()),
  trackUsabilityEvent: vi.fn(),
}));
import { Today } from "./today";

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

test("a retry in flight after a failure reports loading rather than a stale result", () => {
  h.error = new Error("offline");
  h.isFetching = true;
  render(<Today />);
  expect(screen.getByText("Loading setup records...")).toBeTruthy();
  expect(screen.queryAllByText("100%")).toHaveLength(0);
});
