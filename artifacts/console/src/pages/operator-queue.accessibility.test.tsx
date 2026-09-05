// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  OperatorCaseView,
  OperatorQueueStats,
} from "@workspace/api-client-react";

const harness = vi.hoisted(() => ({
  cases: {
    data: [] as OperatorCaseView[] | undefined,
    isLoading: false,
    error: null as Error | null,
    refetch: vi.fn(),
  },
  stats: {
    data: undefined as OperatorQueueStats | undefined,
    isLoading: false,
    error: null as Error | null,
  },
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useGetMe: () => ({ data: { capabilities: ["operator.queue.act"] } }),
    useGetOperatorBrief: () => ({ data: undefined }),
    useListOperatorCases: () => harness.cases,
    useGetOperatorQueueStats: () => harness.stats,
  };
});

import { OperatorQueue } from "./operator-queue";

afterEach(cleanup);
beforeEach(() => {
  harness.cases.data = [];
  harness.cases.isLoading = false;
  harness.cases.error = null;
  harness.stats.data = {
    openCount: 0,
    inProgressCount: 0,
    resolvedCount: 0,
    clientsServed: 0,
    avgHandleSeconds: null,
  };
  harness.stats.isLoading = false;
  harness.stats.error = null;
});

test.each(["loading", "empty", "loaded", "queue-error", "stats-error"])(
  "queue health landmarks have distinct names in the %s state and every case filter",
  (state) => {
    if (state === "loading") {
      harness.cases.data = undefined;
      harness.cases.isLoading = true;
      harness.stats.data = undefined;
      harness.stats.isLoading = true;
    } else if (state === "loaded") {
      harness.cases.data = [
        {
          id: "case-1",
          firmId: "firm-1",
          title: "Submission requires review",
          priority: "medium",
          status: "open",
          openedAt: "2026-09-05T08:00:00.000Z",
        },
      ];
      harness.stats.data!.openCount = 1;
    } else if (state === "queue-error") {
      harness.cases.error = new Error("Queue unavailable");
    } else if (state === "stats-error") {
      harness.stats.data = undefined;
      harness.stats.error = new Error("Metrics unavailable");
    }

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <OperatorQueue />
      </QueryClientProvider>,
    );

    for (const filter of ["open", "in_progress", "resolved"]) {
      fireEvent.click(screen.getByTestId(`tab-${filter}`));
      // Render the real MetricStrip: its named section previously duplicated
      // the enclosing region's heading-derived name despite having no ID.
      const health = screen.getByRole("region", {
        name: "Queue health",
      });
      const metrics = within(health).getByRole("region", {
        name: "Queue health metrics",
      });
      const heading = within(health).getByRole("heading", {
        name: "Queue health",
        level: 2,
      });
      expect(health.getAttribute("aria-labelledby")).toBe(heading.id);
      expect(document.querySelectorAll(`[id="${heading.id}"]`)).toHaveLength(1);
      expect(screen.getAllByRole("region")).toEqual([health, metrics]);
      for (const metric of [
        "open",
        "in-progress",
        "resolved",
        "clients-served",
        "avg-handle",
      ])
        expect(within(metrics).getByTestId(`stat-${metric}`)).toBeTruthy();
    }
    client.clear();
  },
);
