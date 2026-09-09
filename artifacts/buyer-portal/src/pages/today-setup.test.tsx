// @vitest-environment jsdom
// R113: a failed refresh must never present the cached setup checklist as
// confirmed. The page hands the query's error, in-flight state and retry to
// the shared workspace, whose setup panel then reports unavailable (or
// loading) instead of the last percentage. This app ships no DOM testing
// library: a bare react-dom/client mount, queries through the document.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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
          id: "first_invoice",
          label: "Receive the first invoice",
          description: "A supplier's stamped invoice is on record.",
          complete: true,
          href: "/buyer/confirmations",
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

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  h.error = null;
  h.isFetching = false;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
function mount() {
  act(() => root.render(<Today />));
}
const text = () => container.textContent ?? "";

test("a successful read shows the confirmed setup percentage", () => {
  mount();
  expect(text()).not.toContain("Setup progress is unavailable");
  expect(text()).toContain("100%");
});

test("a failed refresh reports setup unavailable, hides the cached percentage and retries the query", () => {
  h.error = new Error("offline");
  mount();
  expect(text()).toContain("Setup progress is unavailable");
  expect(text()).not.toContain("100%");
  const retry = [...container.querySelectorAll("button")].find((button) =>
    /Retry setup/.test(button.textContent ?? ""),
  );
  expect(retry).toBeTruthy();
  act(() => retry?.click());
  expect(h.refetch).toHaveBeenCalledOnce();
});

test("a retry in flight after a failure keeps the retry control busy rather than showing a stale result", () => {
  h.error = new Error("offline");
  h.isFetching = true;
  mount();
  // The unavailable notice and its retry stay mounted while the refetch
  // runs (R115); the heading reports the check and the control refuses a
  // second click.
  expect(text()).toContain("Setup progress is unavailable");
  expect(text()).toContain("Checking setup records");
  const retry = [...container.querySelectorAll("button")].find((button) =>
    /Retry setup/.test(button.textContent ?? ""),
  );
  expect(retry?.getAttribute("aria-busy")).toBe("true");
  act(() => retry?.click());
  expect(h.refetch).not.toHaveBeenCalled();
  expect(text()).not.toContain("100%");
});
