// @vitest-environment jsdom
// The dashboard's view-level behavior. The pins that matter:
//  - First-run (zero invoices): a setup block replaces the work queue —
//    "Today is clear" is earned by an active book, not an empty one — and
//    the empty activity card stays out of the way.
//  - The Compliance tab always has a referent for its count chip: the
//    Next-deadline card mounts there, with an honest empty state.
//  - The Month-end close card's Clerk surfaces (Run with Clerk, the
//    monthly-automation strip) are dark while the clerk_ai feature is,
//    while the deterministic checklist itself survives the gate.
//  - The Clerk tab is dual-gated (capability AND feature) and never blank:
//    the Ask Clerk floor card renders even when every render-on-success
//    card is absent.
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  DashboardSummary,
  Me,
  MonthEndClose,
  PayablesSummary,
} from "@workspace/api-client-react";

// Controllable stand-ins for the generated hooks the page renders with.
const harness = vi.hoisted(() => ({
  me: undefined as unknown,
  summary: undefined as unknown,
  close: undefined as unknown,
  closeSuccess: false,
  payables: undefined as unknown,
  payablesSuccess: false,
  reset() {
    this.me = undefined;
    this.summary = undefined;
    this.close = undefined;
    this.closeSuccess = false;
    this.payables = undefined;
    this.payablesSuccess = false;
  },
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  // Every other query the dashboard's cards fire: settled and empty, so the
  // render-on-success cards are all absent.
  const emptyQuery = () => ({
    data: undefined,
    isSuccess: false,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
  const idleMutation = () => ({
    isPending: false,
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    reset: vi.fn(),
  });
  return {
    ...actual,
    useGetMe: () => ({ data: harness.me }),
    useGetDashboardSummary: () => ({
      data: harness.summary,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }),
    useGetMonthEndClose: () => ({
      data: harness.close,
      isSuccess: harness.closeSuccess,
    }),
    useGetReceivablesSummary: emptyQuery,
    useListPaymentBehaviour: emptyQuery,
    useGetPayablesSummary: () => ({
      data: harness.payables,
      isSuccess: harness.payablesSuccess,
    }),
    useListUnbilledIncome: emptyQuery,
    useGetUnmatchedCredits: emptyQuery,
    useGetCashflowOutlook: emptyQuery,
    useGetNetCashPosition: emptyQuery,
    useGetChaseList: emptyQuery,
    useGetChaseEffectiveness: emptyQuery,
    useGetProjectionAccuracy: emptyQuery,
    useGetPenaltyExposure: emptyQuery,
    useListClientStatements: emptyQuery,
    useListAdvisoryBriefs: emptyQuery,
    useGetClerkDigest: emptyQuery,
    useGetActionProposals: emptyQuery,
    useGetActionPolicies: emptyQuery,
    useGetActionDecisions: emptyQuery,
    useGetClientAutomationEvidence: emptyQuery,
    useGetPlanPolicies: emptyQuery,
    useCreatePlanRun: idleMutation,
    useExecuteAction: idleMutation,
    useGrantPlanPolicy: idleMutation,
    usePausePlanPolicy: idleMutation,
    useResumePlanPolicy: idleMutation,
    useRevokePlanPolicy: idleMutation,
  };
});

// Import AFTER the mock so the page module binds the stand-ins.
import { Dashboard, MonthEndCloseCard } from "./dashboard";

function me(over: Partial<Me> = {}): Me {
  return {
    userId: "u-1",
    role: "client_user",
    email: null,
    fullName: null,
    firmId: "f-1",
    clientPartyId: "cp-1",
    buyerPartyId: null,
    capabilities: ["invoice.read", "clerk.ask", "clerk.capture"],
    features: ["invoice_lifecycle"],
    ...over,
  };
}

function summary(over: Partial<DashboardSummary> = {}): DashboardSummary {
  return {
    clientPartyId: "cp-1",
    totalInvoices: 0,
    draftCount: 0,
    pendingCount: 0,
    stampedCount: 0,
    failedCount: 0,
    cancelledCount: 0,
    unsubmittedCount: 0,
    unsubmittedValue: "0.00",
    stampedValue: "0.00",
    atRiskCount: 0,
    upcomingDeadlineCount: 0,
    nextDeadline: null,
    penaltyRisk: "low",
    recentActivity: [],
    ...over,
  };
}

function monthEndClose(): MonthEndClose {
  return {
    asOf: "2026-08-27",
    attentionCount: 2,
    note: "Advisory only.",
    items: [
      {
        key: "overdue_submissions",
        label: "Overdue submissions",
        detail: "2 invoices are past the reporting window",
        status: "attention",
        count: 2,
      },
    ],
  };
}

function renderWithClient(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", window.location.pathname);
});
beforeEach(() => {
  harness.reset();
  harness.me = me();
  harness.summary = summary();
});

describe("Dashboard first-run (zero invoices)", () => {
  test("a zero-invoice book gets the setup block, not 'Today is clear'", () => {
    harness.summary = summary({ totalInvoices: 0 });
    renderWithClient(<Dashboard />);
    expect(screen.getByTestId("text-first-run").textContent).toBe(
      "Set up your compliance workspace",
    );
    expect(
      screen.getByTestId("link-first-run-create").getAttribute("href"),
    ).toContain("/invoices/new");
    expect(
      screen.getByTestId("link-first-run-import").getAttribute("href"),
    ).toContain("/import");
    expect(screen.queryByText("Today is clear")).toBeNull();
    // The empty activity card has nothing to say until paper exists.
    expect(screen.queryByText("Recent activity")).toBeNull();
  });

  test("an active book keeps the normal work queue", () => {
    harness.summary = summary({ totalInvoices: 3 });
    renderWithClient(<Dashboard />);
    expect(screen.getByText("Today is clear")).toBeTruthy();
    expect(screen.queryByTestId("text-first-run")).toBeNull();
  });
});

describe("Compliance tab's Next-deadline card", () => {
  test("the tab shows the deadline its count chip counts", () => {
    window.history.replaceState(null, "", "?view=compliance");
    harness.summary = summary({
      totalInvoices: 3,
      upcomingDeadlineCount: 1,
      nextDeadline: {
        id: "d-1",
        clientPartyId: "cp-1",
        kind: "vat_return",
        title: "VAT return — August",
        description: null,
        dueDate: "2026-09-21",
        status: "upcoming",
        severity: "warning",
        invoiceId: null,
      },
    });
    renderWithClient(<Dashboard />);
    expect(screen.getByText("Next deadline")).toBeTruthy();
    expect(screen.getByText("VAT return — August")).toBeTruthy();
  });

  test("no deadline renders the honest empty state with the calendar link", () => {
    window.history.replaceState(null, "", "?view=compliance");
    harness.summary = summary({ totalInvoices: 3, nextDeadline: null });
    renderWithClient(<Dashboard />);
    expect(screen.getByTestId("text-no-deadline").textContent).toBe(
      "No upcoming deadlines",
    );
    expect(
      screen.getByTestId("link-deadline-calendar").getAttribute("href"),
    ).toContain("/calendar");
  });
});

describe("MonthEndCloseCard's Clerk gate", () => {
  beforeEach(() => {
    harness.close = monthEndClose();
    harness.closeSuccess = true;
  });

  test("clerk_ai dark: no Run with Clerk, no automation strip — checklist survives", () => {
    harness.me = me({ features: ["invoice_lifecycle"] });
    renderWithClient(<MonthEndCloseCard clientPartyId="cp-1" />);
    expect(screen.queryByTestId("button-run-month-end")).toBeNull();
    expect(screen.queryByTestId("monthly-automation")).toBeNull();
    expect(screen.getByText("Overdue submissions")).toBeTruthy();
  });

  test("clerk_ai lit: Run with Clerk renders", () => {
    harness.me = me({ features: ["invoice_lifecycle", "clerk_ai"] });
    renderWithClient(<MonthEndCloseCard clientPartyId="cp-1" />);
    expect(screen.getByTestId("button-run-month-end")).toBeTruthy();
  });
});

describe("Clerk tab dual gate and floor", () => {
  test("capability without the clerk_ai feature hides the tab", () => {
    harness.me = me({ features: ["invoice_lifecycle"] });
    harness.summary = summary({ totalInvoices: 3 });
    renderWithClient(<Dashboard />);
    // SegmentedControl announces as a toggle-button group (web-ui finding 59),
    // so the view switches are buttons, not tabs.
    expect(screen.queryByRole("button", { name: "Clerk" })).toBeNull();
  });

  test("feature lit shows the tab, and the Ask Clerk floor keeps it non-blank", () => {
    harness.me = me({ features: ["invoice_lifecycle", "clerk_ai"] });
    harness.summary = summary({ totalInvoices: 3 });
    renderWithClient(<Dashboard />);
    expect(screen.getByRole("button", { name: "Clerk" })).toBeTruthy();
    cleanup();

    // Deep-link onto the tab: the digest and actions mocks are non-success,
    // so both self-gating cards are absent — the floor card carries the pane.
    window.history.replaceState(null, "", "?view=clerk");
    renderWithClient(<Dashboard />);
    expect(screen.getByTestId("card-ask-clerk")).toBeTruthy();
    expect(screen.getByTestId("link-ask-clerk").getAttribute("href")).toContain(
      "/clerk/ask",
    );
  });
});

function payablesSummary(): PayablesSummary {
  return {
    clientPartyId: "cp-1",
    groups: [
      {
        currency: "NGN",
        overdue: { amount: "120000.00", count: 2 },
        dueWeeks: [{ startDate: "2026-07-27", amount: "50000.00", count: 1 }],
        later: { amount: "80000.00", count: 2 },
        total: { amount: "250000.00", count: 5 },
      },
    ],
    topSuppliers: [],
  };
}

describe("Money view", () => {
  test("the deep link presses the Money chip and leaves the Today blocks out", () => {
    window.history.replaceState(null, "", "?view=money");
    harness.summary = summary({ totalInvoices: 3 });
    renderWithClient(<Dashboard />);
    expect(
      screen
        .getByRole("button", { name: /Money/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen
        .getByRole("button", { name: /Today/ })
        .getAttribute("aria-pressed"),
    ).toBe("false");
    // The receivables card is shared with the Today view and stays mounted.
    expect(screen.getByText("Receivables")).toBeTruthy();
    // Today-only content: the work queue, the setup block, the activity card.
    expect(screen.queryByText("What needs attention")).toBeNull();
    expect(screen.queryByText("Today is clear")).toBeNull();
    expect(screen.queryByTestId("card-first-run")).toBeNull();
    expect(screen.queryByText("Recent activity")).toBeNull();
    expect(screen.queryByText("Next deadline")).toBeNull();
  });

  test("a zero-invoice book gets no setup block on the Money view either", () => {
    window.history.replaceState(null, "", "?view=money");
    harness.summary = summary({ totalInvoices: 0 });
    renderWithClient(<Dashboard />);
    expect(screen.queryByTestId("card-first-run")).toBeNull();
    expect(screen.queryByTestId("text-first-run")).toBeNull();
    expect(screen.getByText("Receivables")).toBeTruthy();
  });

  test("Receivables precedes Payables in document order", () => {
    window.history.replaceState(null, "", "?view=money");
    harness.summary = summary({ totalInvoices: 3 });
    harness.payables = payablesSummary();
    harness.payablesSuccess = true;
    renderWithClient(<Dashboard />);
    const receivables = screen.getByText("Receivables");
    const payables = screen.getByTestId("card-payables");
    expect(
      receivables.compareDocumentPosition(payables) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
