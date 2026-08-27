// @vitest-environment jsdom
// Feature flags (PL-02): enabling a flag stays a single flick, but disabling
// darkens the surface for EVERY firm the moment the mutation lands — so the
// off direction is confirm-gated behind an AlertDialog and the mutation fires
// solely from the dialog's confirm action.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { FeatureFlag } from "@workspace/api-client-react";

const harness = vi.hoisted(() => ({
  flags: [] as unknown[],
  // Every (vars, callbacks) pair update.mutate was called with, in order.
  mutateCalls: [] as [unknown, unknown][],
  reset() {
    this.flags = [];
    this.mutateCalls = [];
  },
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useGetMe: () => ({ data: { capabilities: ["flags.write"] } }),
    useListFeatureFlags: () => ({
      data: harness.flags,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    }),
    useUpdateFeatureFlag: () => ({
      mutate: (vars: unknown, callbacks: unknown) => {
        harness.mutateCalls.push([vars, callbacks]);
      },
    }),
  };
});

// Import AFTER the mock so the page module binds the stand-ins.
import { FeatureFlags } from "./feature-flags";

function flag(over: Partial<FeatureFlag> = {}): FeatureFlag {
  return {
    key: "reconciliation",
    enabled: false,
    releaseTag: "R2",
    description: null,
    updatedAt: "2026-08-01T09:00:00.000Z",
    ...over,
  };
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <FeatureFlags />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);
beforeEach(() => {
  harness.reset();
});

describe("disable confirm gate", () => {
  test("enabling a dark flag mutates immediately, no dialog", () => {
    harness.flags = [flag({ key: "reconciliation", enabled: false })];
    renderPage();

    fireEvent.click(screen.getByTestId("switch-reconciliation"));
    expect(harness.mutateCalls).toHaveLength(1);
    expect(harness.mutateCalls[0][0]).toEqual({
      key: "reconciliation",
      data: { enabled: true },
    });
    expect(screen.queryByTestId("button-confirm-disable-flag")).toBeNull();
  });

  test("flicking a live flag off only arms the dialog", () => {
    harness.flags = [flag({ key: "reconciliation", enabled: true })];
    renderPage();

    fireEvent.click(screen.getByTestId("switch-reconciliation"));
    expect(harness.mutateCalls).toHaveLength(0);
    expect(screen.getByTestId("button-confirm-disable-flag")).toBeTruthy();
    // The dialog names the flag it is about to darken.
    expect(
      screen.getByText(/Turn off reconciliation for every firm\?/),
    ).toBeTruthy();
  });

  test("confirming fires the disable mutation", () => {
    harness.flags = [flag({ key: "reconciliation", enabled: true })];
    renderPage();

    fireEvent.click(screen.getByTestId("switch-reconciliation"));
    fireEvent.click(screen.getByTestId("button-confirm-disable-flag"));
    expect(harness.mutateCalls).toHaveLength(1);
    expect(harness.mutateCalls[0][0]).toEqual({
      key: "reconciliation",
      data: { enabled: false },
    });
  });

  test("cancelling closes the dialog with zero mutations", () => {
    harness.flags = [flag({ key: "reconciliation", enabled: true })];
    renderPage();

    fireEvent.click(screen.getByTestId("switch-reconciliation"));
    fireEvent.click(screen.getByText("Keep it live"));
    expect(harness.mutateCalls).toHaveLength(0);
    expect(screen.queryByTestId("button-confirm-disable-flag")).toBeNull();
  });
});
