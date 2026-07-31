// @vitest-environment jsdom
// The Obligations surface (Notice Desk): obligations are recorded when the
// firm approves a captured tax-authority notice — the SME app only READS
// them. The server pins a client_user to its own party (no clientPartyId is
// sent) and orders the list soonest deadline first; the page adds display
// logic only (labels, status badges, and the client-side overdue/due-soon
// deadline flags).
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  ListObligationsParams,
  Obligation,
} from "@workspace/api-client-react";

const harness = vi.hoisted(() => ({
  obligations: [] as unknown[],
  listParams: [] as unknown[],
  isLoading: false,
  isError: false,
  reset() {
    this.obligations = [];
    this.listParams = [];
    this.isLoading = false;
    this.isError = false;
  },
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useGetMe: () => ({ data: { capabilities: ["obligation.read"] } }),
    useListObligations: (params: ListObligationsParams) => {
      harness.listParams.push(params);
      return {
        data: { obligations: harness.obligations },
        isLoading: harness.isLoading,
        isError: harness.isError,
        refetch: vi.fn(),
      };
    },
  };
});

// Import AFTER the mock so the page module binds the stand-ins.
import {
  AUTHORITY_LABELS,
  authorityLabel,
  deadlineFlag,
  NOTICE_TYPE_LABELS,
  noticeTypeLabel,
  Obligations,
  obligationStatusLabel,
} from "./obligations";

/** Local calendar day `offset` days from now, as YYYY-MM-DD. */
function isoDaysFromNow(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

function obligation(over: Partial<Obligation> = {}): Obligation {
  return {
    id: "ob-1",
    firmId: "f-1",
    clientPartyId: "cp-1",
    noticeType: "assessment",
    authority: "firs",
    reference: "FIRS/2026/0042",
    period: "2026-Q1",
    amount: "250000.00",
    currency: "NGN",
    responseDueDate: isoDaysFromNow(30),
    status: "open",
    createdBy: "u-1",
    createdAt: "2026-07-01T10:00:00Z",
    updatedAt: "2026-07-01T10:00:00Z",
    ...over,
  };
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <Obligations />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);
beforeEach(() => {
  harness.reset();
});

describe("display vocabulary", () => {
  test("label maps cover the server's closed catalogues, with fallbacks", () => {
    expect(NOTICE_TYPE_LABELS.information_request).toBe("Information request");
    expect(AUTHORITY_LABELS.state_irs).toBe("State IRS");
    expect(noticeTypeLabel("demand")).toBe("Demand notice");
    expect(authorityLabel("firs")).toBe("FIRS");
    // Off-catalogue tokens from a newer server degrade to humanize().
    expect(noticeTypeLabel("levy_review")).toBe("Levy review");
    expect(authorityLabel("lga")).toBe("Lga");
  });

  test("status labels read as the response lifecycle", () => {
    expect(obligationStatusLabel("open")).toBe("Awaiting response");
    expect(obligationStatusLabel("responded")).toBe("Responded");
    expect(obligationStatusLabel("closed")).toBe("Closed");
    expect(obligationStatusLabel("in_dispute")).toBe("In dispute");
  });
});

describe("deadlineFlag", () => {
  const TODAY = "2026-07-30";

  test("a due date before today is overdue", () => {
    expect(deadlineFlag("2026-07-29", TODAY)).toBe("overdue");
    expect(deadlineFlag("2026-01-01", TODAY)).toBe("overdue");
  });

  test("due today through 7 days out is due-soon; day 8 is unflagged", () => {
    expect(deadlineFlag(TODAY, TODAY)).toBe("due-soon");
    expect(deadlineFlag("2026-08-06", TODAY)).toBe("due-soon");
    expect(deadlineFlag("2026-08-07", TODAY)).toBeNull();
  });

  test("an unparseable date never flags", () => {
    expect(deadlineFlag("not-a-date", TODAY)).toBeNull();
  });
});

describe("obligations list", () => {
  test("rows show notice type, authority, reference, period, amount and deadline", () => {
    harness.obligations = [
      obligation(),
      obligation({
        id: "ob-2",
        noticeType: "information_request",
        authority: "customs",
        reference: null,
        period: null,
        amount: "1200.00",
        currency: "USD",
        status: "responded",
      }),
    ];
    renderPage();

    const row1 = screen.getByTestId("row-obligation-ob-1");
    expect(row1.textContent).toContain("Assessment");
    expect(row1.textContent).toContain("FIRS");
    expect(row1.textContent).toContain("Ref FIRS/2026/0042");
    expect(row1.textContent).toContain("2026-Q1");
    expect(row1.textContent).toContain("₦250,000");
    expect(row1.textContent).toContain("Respond by");
    expect(screen.getByTestId("badge-status-ob-1").textContent).toBe(
      "Awaiting response",
    );

    const row2 = screen.getByTestId("row-obligation-ob-2");
    expect(row2.textContent).toContain("Information request");
    expect(row2.textContent).toContain("Customs");
    // A foreign-currency figure never masquerades as naira.
    expect(row2.textContent).toContain("1,200.00 USD");
    expect(screen.getByTestId("badge-status-ob-2").textContent).toBe(
      "Responded",
    );
  });

  test("an open obligation past its deadline wears the Overdue flag", () => {
    harness.obligations = [
      obligation({ responseDueDate: isoDaysFromNow(-1) }),
      obligation({ id: "ob-2", responseDueDate: isoDaysFromNow(2) }),
      obligation({ id: "ob-3", responseDueDate: isoDaysFromNow(30) }),
    ];
    renderPage();

    expect(screen.getByTestId("flag-deadline-ob-1").textContent).toBe(
      "Overdue",
    );
    expect(screen.getByTestId("flag-deadline-ob-2").textContent).toBe(
      "Due soon",
    );
    expect(screen.queryByTestId("flag-deadline-ob-3")).toBeNull();
  });

  test("a responded obligation never reads as overdue, even past its deadline", () => {
    harness.obligations = [
      obligation({ status: "responded", responseDueDate: isoDaysFromNow(-10) }),
    ];
    renderPage();
    expect(screen.queryByTestId("flag-deadline-ob-1")).toBeNull();
  });

  test("filters default to open and switch the status param (all sends none)", () => {
    harness.obligations = [obligation()];
    renderPage();
    expect(harness.listParams[0]).toEqual({ status: "open" });

    fireEvent.click(screen.getByTestId("filter-obligations-responded"));
    expect(harness.listParams.at(-1)).toEqual({ status: "responded" });

    fireEvent.click(screen.getByTestId("filter-obligations-all"));
    expect(harness.listParams.at(-1)).toEqual({});
  });

  test("an empty filtered list explains itself and offers the all view", () => {
    renderPage();
    expect(screen.getByTestId("text-empty").textContent).toBe(
      "No open obligations",
    );
    fireEvent.click(screen.getByTestId("button-show-all-obligations"));
    expect(harness.listParams.at(-1)).toEqual({});
    expect(screen.getByTestId("text-empty").textContent).toBe(
      "No obligations recorded",
    );
    expect(screen.queryByTestId("button-show-all-obligations")).toBeNull();
  });

  test("a failed fetch renders the shared error state", () => {
    harness.isError = true;
    renderPage();
    expect(screen.getByTestId("text-error").textContent).toBe(
      "Unable to load your obligations.",
    );
  });
});
