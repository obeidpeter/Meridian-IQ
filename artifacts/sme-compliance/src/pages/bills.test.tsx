// @vitest-environment jsdom
// The supplier-bills surface (contract 0.44.0): bills are captured supplier
// invoices where the client is the BUYER — they live outside the invoice
// vault, all data comes from /bills, and the two row actions are evidence
// only: a payment flag never edits the document, and a stamp verification
// stores its result on the bill.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  BillSummary,
  BillVerification,
} from "@workspace/api-client-react";

const harness = vi.hoisted(() => ({
  bills: [] as unknown[],
  flagCalls: [] as { id: string; data: { status: string } }[],
  verifyCalls: [] as { id: string; data: { irn: string; csid: string } }[],
  verifyResult: null as unknown,
  reset() {
    this.bills = [];
    this.flagCalls = [];
    this.verifyCalls = [];
    this.verifyResult = null;
  },
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useGetMe: () => ({ data: { clientPartyId: "cp-1" } }),
    useListBills: () => ({
      data: harness.bills,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }),
    useFlagBillPayment: () => ({
      isPending: false,
      mutateAsync: (vars: { id: string; data: { status: string } }) => {
        harness.flagCalls.push(vars);
        return Promise.resolve({});
      },
    }),
    useVerifyBillStamp: () => ({
      isPending: false,
      mutateAsync: (vars: { id: string; data: { irn: string; csid: string } }) => {
        harness.verifyCalls.push(vars);
        return Promise.resolve(harness.verifyResult);
      },
    }),
  };
});

// Import AFTER the mock so the page module binds the stand-ins.
import { Bills } from "./bills";

function bill(over: Partial<BillSummary> = {}): BillSummary {
  return {
    invoiceId: "b-1",
    invoiceNumber: "SUP-001",
    supplierPartyId: "sp-1",
    supplierName: "Dangote Cement",
    issueDate: "2026-07-01",
    dueDate: "2026-08-01",
    currency: "NGN",
    grandTotal: "250000.00",
    payStatus: "open",
    lastVerification: null,
    ...over,
  };
}

function verification(valid: boolean): BillVerification {
  return {
    invoiceId: "b-1",
    irn: "IRN-1",
    csid: "CSID-1",
    valid,
    eligible: valid ? true : null,
    checkedAt: "2026-07-20T10:00:00Z",
  };
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <Bills />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);
beforeEach(() => {
  harness.reset();
});

describe("bills list", () => {
  test("rows show number, supplier, dates, status pill and verification chip", () => {
    harness.bills = [
      bill({
        lastVerification: { valid: true, eligible: true, checkedAt: "2026-07-20T10:00:00Z" },
      }),
      bill({
        invoiceId: "b-2",
        invoiceNumber: "SUP-002",
        supplierName: "BUA Foods",
        payStatus: "paid",
        dueDate: null,
        lastVerification: { valid: false, eligible: null, checkedAt: "2026-07-21T10:00:00Z" },
      }),
    ];
    renderPage();

    const row1 = screen.getByTestId("row-bill-b-1");
    expect(row1.textContent).toContain("SUP-001");
    expect(row1.textContent).toContain("Dangote Cement");
    expect(row1.textContent).toContain("Unpaid");
    expect(screen.getByTestId("chip-verification-b-1").textContent).toBe(
      "Stamp valid",
    );

    const row2 = screen.getByTestId("row-bill-b-2");
    expect(row2.textContent).toContain("Paid");
    expect(screen.getByTestId("chip-verification-b-2").textContent).toBe(
      "Stamp not found",
    );
  });

  test("status filter pills narrow the rows and carry counts", () => {
    harness.bills = [
      bill(),
      bill({ invoiceId: "b-2", invoiceNumber: "SUP-002", payStatus: "scheduled" }),
      bill({ invoiceId: "b-3", invoiceNumber: "SUP-003", payStatus: "paid" }),
    ];
    renderPage();

    expect(screen.getByTestId("filter-bills-all").textContent).toBe("All · 3");
    expect(screen.getByTestId("filter-bills-open").textContent).toBe(
      "Unpaid · 1",
    );
    expect(screen.getByTestId("filter-bills-paid").textContent).toBe(
      "Paid · 1",
    );

    fireEvent.click(screen.getByTestId("filter-bills-paid"));
    expect(screen.queryByTestId("row-bill-b-1")).toBeNull();
    expect(screen.queryByTestId("row-bill-b-2")).toBeNull();
    expect(screen.getByTestId("row-bill-b-3")).toBeTruthy();
  });

  test("empty book shows the Clerk-capture explanation", () => {
    renderPage();
    expect(screen.getByTestId("text-empty").textContent).toBe(
      "No supplier bills yet",
    );
    expect(
      screen.getByText(
        /Documents you send to Clerk where you are the buyer will show up here/,
      ),
    ).toBeTruthy();
  });
});

describe("payment flags", () => {
  test("flagging paid confirms with the evidence copy, then posts the flag", async () => {
    harness.bills = [bill()];
    renderPage();

    fireEvent.click(screen.getByTestId("button-expand-bill-b-1"));
    fireEvent.click(screen.getByTestId("button-flag-paid-b-1"));

    // The confirm step carries the promise that a flag is evidence, not an
    // edit of the captured document.
    expect(
      screen.getByText(
        "This records payment evidence on the bill — it never edits the document.",
      ),
    ).toBeTruthy();
    expect(harness.flagCalls).toHaveLength(0);

    fireEvent.click(screen.getByTestId("button-confirm-flag"));
    await waitFor(() => expect(harness.flagCalls).toHaveLength(1));
    expect(harness.flagCalls[0]).toEqual({
      id: "b-1",
      data: { status: "paid" },
    });
  });

  test("scheduling posts a scheduled flag", async () => {
    harness.bills = [bill()];
    renderPage();

    fireEvent.click(screen.getByTestId("button-expand-bill-b-1"));
    fireEvent.click(screen.getByTestId("button-flag-scheduled-b-1"));
    fireEvent.click(screen.getByTestId("button-confirm-flag"));
    await waitFor(() => expect(harness.flagCalls).toHaveLength(1));
    expect(harness.flagCalls[0]).toEqual({
      id: "b-1",
      data: { status: "scheduled" },
    });
  });

  test("a paid bill disables both flags; a scheduled bill can still be marked paid", () => {
    harness.bills = [
      bill({ payStatus: "paid" }),
      bill({ invoiceId: "b-2", invoiceNumber: "SUP-002", payStatus: "scheduled" }),
    ];
    renderPage();

    fireEvent.click(screen.getByTestId("button-expand-bill-b-1"));
    expect(
      (screen.getByTestId("button-flag-paid-b-1") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId("button-flag-scheduled-b-1") as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    fireEvent.click(screen.getByTestId("button-expand-bill-b-2"));
    expect(
      (screen.getByTestId("button-flag-paid-b-2") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(
      (screen.getByTestId("button-flag-scheduled-b-2") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});

describe("stamp verification", () => {
  test("verifying posts IRN+CSID and renders the valid result inline", async () => {
    harness.bills = [bill()];
    harness.verifyResult = verification(true);
    renderPage();

    fireEvent.click(screen.getByTestId("button-expand-bill-b-1"));

    // Both fields are required before the check can run.
    expect(
      (screen.getByTestId("button-verify-bill-b-1") as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    fireEvent.change(screen.getByTestId("input-verify-irn-b-1"), {
      target: { value: "IRN-1" },
    });
    fireEvent.change(screen.getByTestId("input-verify-csid-b-1"), {
      target: { value: "CSID-1" },
    });
    fireEvent.click(screen.getByTestId("button-verify-bill-b-1"));

    await screen.findByTestId("text-verify-result-b-1");
    expect(screen.getByTestId("text-verify-result-b-1").textContent).toBe(
      "Valid stamp",
    );
    expect(harness.verifyCalls).toHaveLength(1);
    expect(harness.verifyCalls[0]).toEqual({
      id: "b-1",
      data: { irn: "IRN-1", csid: "CSID-1" },
    });
  });

  test("a miss renders the not-found wording", async () => {
    harness.bills = [bill()];
    harness.verifyResult = verification(false);
    renderPage();

    fireEvent.click(screen.getByTestId("button-expand-bill-b-1"));
    fireEvent.change(screen.getByTestId("input-verify-irn-b-1"), {
      target: { value: "IRN-X" },
    });
    fireEvent.change(screen.getByTestId("input-verify-csid-b-1"), {
      target: { value: "CSID-X" },
    });
    fireEvent.click(screen.getByTestId("button-verify-bill-b-1"));

    await screen.findByTestId("text-verify-result-b-1");
    expect(screen.getByTestId("text-verify-result-b-1").textContent).toBe(
      "Not found on the national record",
    );
  });
});
