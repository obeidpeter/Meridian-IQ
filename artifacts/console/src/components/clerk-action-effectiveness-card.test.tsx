// @vitest-environment jsdom
// The action-effectiveness card (round 29): renders only when the window
// holds decisions, splits auto vs hand-approved, re-reads executed submit
// targets against their CURRENT rail status (failed-again is surfaced,
// never buried), and phrases the exposure estimate with the standing
// not-advice disclaimer. Chaser rows carry no now-line — drafted text has
// no rail lifecycle to verify.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  ActionEffectivenessKindRow,
  ActionEffectivenessReport,
} from "@workspace/api-client-react";

const harness = vi.hoisted(() => ({
  report: {
    data: undefined as unknown,
    isSuccess: false,
  },
  reset() {
    this.report.data = undefined;
    this.report.isSuccess = false;
  },
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useGetActionEffectiveness: () => ({
      data: harness.report.data,
      isSuccess: harness.report.isSuccess,
    }),
  };
});

// Import AFTER the mock so the component module binds the stand-in.
import { ClerkActionEffectivenessCard } from "./clerk-action-effectiveness-card";

function kindRow(
  over: Partial<ActionEffectivenessKindRow> = {},
): ActionEffectivenessKindRow {
  return {
    kind: "submit_overdue",
    decisions: 2,
    autoDecisions: 1,
    requested: 6,
    executed: 4,
    skipped: 1,
    failed: 1,
    nowSucceeded: 2,
    nowInFlight: 1,
    nowFailedAgain: 1,
    nowOther: 0,
    ...over,
  };
}

function report(
  over: Partial<ActionEffectivenessReport> = {},
): ActionEffectivenessReport {
  return {
    windowDays: 90,
    totals: { decisions: 3, autoDecisions: 1, executed: 5, failed: 1 },
    exposureFloorClearedNgn: "40000",
    kinds: [
      kindRow(),
      kindRow({
        kind: "draft_chasers",
        decisions: 1,
        autoDecisions: 0,
        requested: 1,
        executed: 1,
        skipped: 0,
        failed: 0,
        nowSucceeded: null,
        nowInFlight: null,
        nowFailedAgain: null,
        nowOther: null,
      }),
    ],
    ...over,
  };
}

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ClerkActionEffectivenessCard clientPartyId="cp-1" />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);
beforeEach(() => {
  harness.reset();
});

describe("ClerkActionEffectivenessCard", () => {
  test("hides while loading and when the window holds no decisions", () => {
    renderCard();
    expect(screen.queryByTestId("card-action-effectiveness")).toBeNull();
    cleanup();

    harness.report.isSuccess = true;
    harness.report.data = report({
      totals: { decisions: 0, autoDecisions: 0, executed: 0, failed: 0 },
      kinds: [],
      exposureFloorClearedNgn: "0",
    });
    renderCard();
    expect(screen.queryByTestId("card-action-effectiveness")).toBeNull();
  });

  test("summarizes the window, splits auto, and re-reads the rails per kind", () => {
    harness.report.isSuccess = true;
    harness.report.data = report();
    renderCard();

    expect(
      screen.getByTestId("text-effectiveness-summary").textContent,
    ).toContain("3 decisions in the last 90 days — 1 ran automatically");

    const overdue = screen.getByTestId("effectiveness-submit_overdue");
    expect(overdue.textContent).toContain("2 decisions (1 auto)");
    expect(overdue.textContent).toContain("4 executed · 1 skipped · 1 failed");
    expect(
      screen.getByTestId("effectiveness-now-submit_overdue").textContent,
    ).toBe("now: 2 stamped or beyond · 1 in flight · 1 failed again");

    // Chaser rows carry no now-line — nothing on the rails to verify.
    expect(
      screen.queryByTestId("effectiveness-now-draft_chasers"),
    ).toBeNull();

    const exposure = screen.getByTestId("text-effectiveness-exposure");
    expect(exposure.textContent).toContain("₦40,000.00");
    expect(exposure.textContent).toContain("not advice");
  });

  test("the exposure line hides when nothing overdue was submitted", () => {
    harness.report.isSuccess = true;
    harness.report.data = report({
      exposureFloorClearedNgn: "0",
      kinds: [
        kindRow({
          kind: "retry_failed",
          nowSucceeded: 1,
          nowInFlight: 0,
          nowFailedAgain: 0,
          nowOther: 0,
          decisions: 3,
          autoDecisions: 0,
          executed: 5,
          skipped: 0,
          failed: 0,
        }),
      ],
    });
    renderCard();
    expect(screen.queryByTestId("text-effectiveness-exposure")).toBeNull();
    expect(
      screen.getByTestId("effectiveness-retry_failed").textContent,
    ).toContain("3 decisions");
  });
});
