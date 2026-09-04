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
  overrides: [] as unknown[],
  firms: [] as unknown[],
  // Every (vars, callbacks) pair update.mutate was called with, in order.
  mutateCalls: [] as [unknown, unknown][],
  overrideCalls: [] as unknown[],
  clearCalls: [] as unknown[],
  reset() {
    this.flags = [];
    this.overrides = [];
    this.firms = [];
    this.mutateCalls = [];
    this.overrideCalls = [];
    this.clearCalls = [];
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
    useListFeatureFlagOverrides: () => ({
      data: harness.overrides,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    }),
    useListFirms: () => ({ data: harness.firms }),
    useSetFeatureFlagOverride: () => ({
      mutate: (vars: unknown) => {
        harness.overrideCalls.push(vars);
      },
    }),
    useClearFeatureFlagOverride: () => ({
      mutate: (vars: unknown) => {
        harness.clearCalls.push(vars);
      },
    }),
  };
});

// Import AFTER the mock so the page module binds the stand-ins.
import { FeatureFlags } from "./feature-flags";

// The cohort form's Switch sits inside a <form>, so Radix mounts its hidden
// form input and measures it with ResizeObserver, which jsdom lacks.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??=
  ResizeObserverStub;

function flag(over: Partial<FeatureFlag> = {}): FeatureFlag {
  return {
    key: "reconciliation",
    enabled: false,
    releaseTag: "R2",
    description: null,
    updatedAt: "2026-08-01T09:00:00.000Z",
    overrideCount: 0,
    requires: [],
    unmetPrerequisites: [],
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

// R99: the pilot cohort under each flag — who is in, why, and the two
// audited moves (set with a reason, clear back to the platform default).
describe("pilot cohort", () => {
  test("expanding the cohort lists each firm override with its reason; clear fires the mutation", () => {
    harness.flags = [flag({ key: "reconciliation", overrideCount: 1 })];
    harness.overrides = [
      {
        flagKey: "reconciliation",
        firmId: "firm-a",
        firmName: "Ade & Co",
        enabled: true,
        reason: "Pilot cohort 1",
        setByUserId: "op-1",
        createdAt: "2026-08-01T09:00:00.000Z",
        updatedAt: "2026-08-02T09:00:00.000Z",
      },
    ];
    renderPage();

    expect(
      screen.getByTestId("button-cohort-reconciliation").textContent,
    ).toMatch(/Pilot cohort \(1\)/);
    expect(screen.queryByTestId("cohort-reconciliation")).toBeNull();
    fireEvent.click(screen.getByTestId("button-cohort-reconciliation"));
    const row = screen.getByTestId("override-reconciliation-firm-a");
    expect(row.textContent).toMatch(/Ade & Co/);
    expect(row.textContent).toMatch(/On for this firm/);
    expect(row.textContent).toMatch(/Pilot cohort 1/);

    fireEvent.click(
      screen.getByTestId("button-clear-override-reconciliation-firm-a"),
    );
    expect(harness.clearCalls).toEqual([
      { key: "reconciliation", firmId: "firm-a" },
    ]);
  });

  test("setting an override needs a firm and a reason, then sends both", () => {
    harness.flags = [flag({ key: "reconciliation" })];
    harness.firms = [{ id: "firm-b", name: "Bola Partners" }];
    renderPage();
    fireEvent.click(screen.getByTestId("button-cohort-reconciliation"));
    expect(screen.getByTestId("text-cohort-empty-reconciliation")).toBeTruthy();

    const submit = screen.getByTestId(
      "button-set-override-reconciliation",
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(
      screen.getByTestId("select-override-firm-reconciliation"),
      {
        target: { value: "firm-b" },
      },
    );
    expect(submit.disabled).toBe(true);
    fireEvent.change(
      screen.getByTestId("input-override-reason-reconciliation"),
      {
        target: { value: "Cohort 2 pilot" },
      },
    );
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    expect(harness.overrideCalls).toEqual([
      {
        key: "reconciliation",
        data: { firmId: "firm-b", enabled: true, reason: "Cohort 2 pilot" },
      },
    ]);
  });
});
