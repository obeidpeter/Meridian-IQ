// @vitest-environment jsdom
// Characterization of the invoice detail SHELL (R126): the page states and
// the action row the split must keep byte-for-byte. invoice-detail.test.tsx
// only mounts the cards through the index re-exports and the e2e lifecycle
// journey only touches the credit-note dialog and button-edit-invoice, so
// this suite is the unit-level proof for the shell itself:
//  - loading skeleton; a non-404 fetch failure shows the shared retry state;
//    a 404 shows the neutral not-found card.
//  - draft: the header, the action row (edit, download, cancel, new-from;
//    no credit note), and "Submit for stamping" confirm-gated behind the
//    review dialog, validating BEFORE submitting.
//  - failed: the catalogue card, Clerk's explain button, fix & resubmit,
//    escalate; "Retry transmission" submits without re-validating.
//  - stamped: the FIRS stamp card, the credit-note action, the pin toggle.
//  - line items with the naira equivalent for a foreign-currency invoice.
//  - "New from this invoice" asks before replacing a stored draft with work.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithClient } from "../test-utils";
import type {
  ErrorCatalogueEntry,
  Invoice,
  InvoiceDetail as InvoiceDetailData,
  InvoiceLine,
  Me,
  StampRecord,
  SubmissionAttempt,
} from "@workspace/api-client-react";
import {
  draftStorageKey,
  emptyInvoiceDraft,
  loadInvoiceDraft,
  saveInvoiceDraft,
} from "@/lib/invoice-draft";

// Controllable stand-ins for the generated hooks the shell renders with.
const harness = vi.hoisted(() => ({
  invoice: {
    data: undefined as unknown,
    isLoading: false,
    isError: false,
    error: undefined as unknown,
    refetch: vi.fn(),
  },
  party: undefined as unknown,
  attempts: undefined as unknown,
  stamp: undefined as unknown,
  catalogue: undefined as unknown,
  me: undefined as unknown,
  validateResult: { ok: true, errors: [] } as unknown,
  // Every mutation call in the order it was made, with its variables.
  calls: [] as Array<{ name: string; vars: unknown }>,
  reset() {
    this.invoice.data = undefined;
    this.invoice.isLoading = false;
    this.invoice.isError = false;
    this.invoice.error = undefined;
    this.invoice.refetch.mockReset();
    this.party = undefined;
    this.attempts = undefined;
    this.stamp = undefined;
    this.catalogue = undefined;
    this.me = undefined;
    this.validateResult = { ok: true, errors: [] };
    this.calls = [];
  },
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  // Every other query the page and its cards fire: settled and empty, so the
  // render-on-success cards are all absent.
  const emptyQuery = () => ({
    data: undefined,
    error: undefined,
    isSuccess: false,
    isLoading: false,
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  });
  const idleMutation = () => ({
    data: undefined,
    isPending: false,
    isError: false,
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    reset: vi.fn(),
  });
  const recording = (name: string, result: () => unknown) => () => ({
    data: undefined,
    isPending: false,
    isError: false,
    mutate: (vars: unknown) => {
      harness.calls.push({ name, vars });
    },
    mutateAsync: (vars: unknown) => {
      harness.calls.push({ name, vars });
      return Promise.resolve(result());
    },
    reset: vi.fn(),
  });
  return {
    ...actual,
    useGetInvoice: () => ({
      data: harness.invoice.data,
      isLoading: harness.invoice.isLoading,
      isError: harness.invoice.isError,
      error: harness.invoice.error,
      refetch: harness.invoice.refetch,
    }),
    useGetParty: () => ({ data: harness.party }),
    useListSubmissionAttempts: () => ({ data: harness.attempts }),
    useGetInvoiceStamp: () => ({ data: harness.stamp }),
    useGetErrorCatalogueEntry: () => ({ data: harness.catalogue }),
    useGetMe: () => ({ data: harness.me }),
    useListEscalations: emptyQuery,
    useListConfirmations: emptyQuery,
    useListSettlements: emptyQuery,
    useGetInvoiceStatusLight: emptyQuery,
    useGetInvoiceRejectionRisk: emptyQuery,
    useValidateInvoice: recording("validate", () => harness.validateResult),
    useSubmitInvoice: recording("submit", () => ({})),
    useUpdateInvoice: idleMutation,
    useExplainInvoiceFailure: recording("explain", () => ({})),
    useEscalateInvoice: idleMutation,
    useCancelInvoice: idleMutation,
    useCreditNoteInvoice: idleMutation,
    useCreateConfirmation: idleMutation,
    // The cards the shell mounts (ApprovalsCard, PaymentReminderCard).
    useListInvoiceApprovals: emptyQuery,
    useApproveInvoice: idleMutation,
    useDraftPaymentChaser: idleMutation,
    useRecordChaseReminder: idleMutation,
    useListPaymentBehaviour: emptyQuery,
  };
});

// Import AFTER the mock so the page module binds the stand-ins.
import { InvoiceDetail } from "./invoice-detail";

function me(over: Partial<Me> = {}): Me {
  return {
    userId: "u-1",
    role: "client_user",
    email: null,
    fullName: null,
    firmId: "f-1",
    clientPartyId: "cp-1",
    buyerPartyId: null,
    capabilities: ["invoice.read", "clerk.capture"],
    features: ["invoice_lifecycle"],
    ...over,
  };
}

function invoice(over: Partial<Invoice> = {}): Invoice {
  return {
    id: "inv-1",
    firmId: "f-1",
    supplierPartyId: "sup-1",
    buyerPartyId: "buy-1",
    kind: "invoice",
    category: "b2b",
    relatedInvoiceId: null,
    invoiceNumber: "INV-001",
    currency: "NGN",
    fxRateToNgn: null,
    issueDate: "2026-08-01",
    dueDate: "2026-08-31",
    status: "draft",
    subtotal: "100000.00",
    vatTotal: "7500.00",
    grandTotal: "107500.00",
    whtCategory: null,
    notes: null,
    legalHold: false,
    retentionUntil: null,
    contentRevision: 1,
    schemaVersion: 1,
    createdAt: "2026-08-01T09:00:00.000Z",
    updatedAt: "2026-08-01T09:00:00.000Z",
    ...over,
  };
}

function line(): InvoiceLine {
  return {
    id: "ln-1",
    invoiceId: "inv-1",
    lineNo: 1,
    description: "Consulting retainer",
    quantity: "2",
    unitPrice: "50000.00",
    vatRate: "0.075",
    lineExtension: "100000.00",
    vatAmount: "7500.00",
  };
}

function detail(over: Partial<Invoice> = {}): InvoiceDetailData {
  return { invoice: invoice(over), lines: [line()] };
}

function attempt(over: Partial<SubmissionAttempt> = {}): SubmissionAttempt {
  return {
    id: "att-1",
    invoiceId: "inv-1",
    rail: "rail_primary",
    attemptNo: 1,
    idempotencyKey: "idem-1",
    correlationId: null,
    status: "rejected",
    errorCode: "E-TIN-01",
    createdAt: "2026-08-02T09:00:00.000Z",
    ...over,
  };
}

function catalogue(): ErrorCatalogueEntry {
  return {
    code: "E-TIN-01",
    cause: "The buyer's TIN is not registered with the rail.",
    fix: "Correct the buyer's TIN on the party record, then resubmit.",
    retriable: false,
  };
}

function stamp(): StampRecord {
  return {
    id: "stamp-1",
    invoiceId: "inv-1",
    irn: "IRN-2026-0001",
    csid: "CSID-ABCDEF",
    qrPayload: "qr",
    signedArtifactRef: "artifact-1",
    rail: "rail_primary",
    createdAt: "2026-08-03T09:00:00.000Z",
  };
}

afterEach(cleanup);
beforeEach(() => {
  harness.reset();
  harness.me = me();
  // usePinnedItems, the operation journal and the invoice-form draft all
  // persist to storage: start every test from a clean slate.
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/invoices/inv-1");
});

describe("page states", () => {
  test("loading renders the skeleton and no header", () => {
    harness.invoice.isLoading = true;
    const { container } = renderWithClient(<InvoiceDetail />);
    expect(container.querySelector(".animate-pulse")).toBeTruthy();
    expect(screen.queryByTestId("text-page-title")).toBeNull();
  });

  test("a non-404 failure shows the shared retry state, not the not-found card", () => {
    harness.invoice.isError = true;
    harness.invoice.error = { status: 500 };
    renderWithClient(<InvoiceDetail />);
    expect(screen.getByTestId("text-error").textContent).toBe(
      "Unable to load this invoice.",
    );
    expect(screen.queryByTestId("card-unknown-invoice")).toBeNull();
    fireEvent.click(screen.getByText("Try again"));
    expect(harness.invoice.refetch).toHaveBeenCalledTimes(1);
  });

  test("a 404 shows the neutral not-found card", () => {
    harness.invoice.isError = true;
    harness.invoice.error = { status: 404 };
    renderWithClient(<InvoiceDetail />);
    expect(screen.getByTestId("card-unknown-invoice")).toBeTruthy();
    expect(screen.getByTestId("text-error").textContent).toBe(
      "We couldn't find this invoice",
    );
  });
});

describe("draft invoice", () => {
  beforeEach(() => {
    harness.invoice.data = detail({ whtCategory: "professional_services" });
  });

  test("header, WHT category line and the action row", () => {
    renderWithClient(<InvoiceDetail />);
    expect(screen.getByTestId("text-page-title").textContent).toBe("INV-001");
    expect(screen.getByTestId("text-invoice-wht-category").textContent).toMatch(
      /^WHT category: /,
    );
    expect(
      screen.getByTestId("link-help-stamping").getAttribute("href"),
    ).toContain("/help#stamping");
    expect(screen.getByTestId("button-edit-invoice")).toBeTruthy();
    expect(screen.getByTestId("button-download-pdf")).toBeTruthy();
    expect(screen.getByTestId("button-new-from-invoice")).toBeTruthy();
    expect(screen.getByTestId("button-cancel-invoice")).toBeTruthy();
    expect(screen.queryByTestId("button-credit-note")).toBeNull();
    expect(screen.getByText("Submit for stamping")).toBeTruthy();
  });

  test("Edit invoice opens the fix form in the edit card and hides the button", () => {
    renderWithClient(<InvoiceDetail />);
    expect(screen.queryByTestId("card-edit-invoice")).toBeNull();
    fireEvent.click(screen.getByTestId("button-edit-invoice"));
    expect(screen.getByTestId("card-edit-invoice")).toBeTruthy();
    expect(screen.getByTestId("fix-form")).toBeTruthy();
    expect(screen.queryByTestId("button-edit-invoice")).toBeNull();
  });

  test("submitting is confirm-gated and validates before it submits", async () => {
    renderWithClient(<InvoiceDetail />);
    expect(screen.queryByTestId("button-confirm-submit")).toBeNull();
    fireEvent.click(screen.getByText("Submit for stamping"));
    expect(screen.getByText("Review before submitting")).toBeTruthy();
    // Nothing was sent by opening the dialog.
    expect(harness.calls).toEqual([]);
    fireEvent.click(screen.getByTestId("button-confirm-submit"));
    await waitFor(() =>
      expect(harness.calls.map((c) => c.name)).toEqual(["validate", "submit"]),
    );
    expect(harness.calls[0].vars).toEqual({ id: "inv-1" });
    expect(harness.calls[1].vars).toEqual({ id: "inv-1" });
  });

  test("a validation failure stops before submit and lists the errors", async () => {
    harness.validateResult = {
      ok: false,
      errors: [{ field: "buyerPartyId", message: "Buyer TIN is invalid." }],
    };
    renderWithClient(<InvoiceDetail />);
    fireEvent.click(screen.getByText("Submit for stamping"));
    fireEvent.click(screen.getByTestId("button-confirm-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("card-validation-errors")).toBeTruthy(),
    );
    expect(screen.getByTestId("row-validation-error-0").textContent).toContain(
      "Buyer TIN is invalid.",
    );
    expect(harness.calls.map((c) => c.name)).toEqual(["validate"]);
  });
});

describe("failed invoice", () => {
  beforeEach(() => {
    harness.invoice.data = detail({ status: "failed" });
    harness.attempts = [attempt()];
    harness.catalogue = catalogue();
  });

  test("the catalogue card explains the failure with the reference code", () => {
    renderWithClient(<InvoiceDetail />);
    expect(screen.getByText("Submission failed")).toBeTruthy();
    expect(
      screen.getByText("The buyer's TIN is not registered with the rail."),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Correct the buyer's TIN on the party record, then resubmit.",
      ),
    ).toBeTruthy();
    // The reference code also appears on the submission timeline below.
    expect(screen.getAllByText("E-TIN-01").length).toBeGreaterThan(0);
    expect(screen.getByText(/not retriable/)).toBeTruthy();
    // No edit button on a failed invoice: the fix lives on the failure card.
    expect(screen.queryByTestId("button-edit-invoice")).toBeNull();
  });

  test("Clerk's explanation is button-triggered, never automatic", () => {
    renderWithClient(<InvoiceDetail />);
    expect(harness.calls).toEqual([]);
    fireEvent.click(screen.getByTestId("button-explain-failure"));
    expect(harness.calls).toEqual([
      { name: "explain", vars: { data: { invoiceId: "inv-1" } } },
    ]);
  });

  test("Fix & resubmit opens the fix form inside the failure card", () => {
    renderWithClient(<InvoiceDetail />);
    fireEvent.click(screen.getByTestId("button-open-fix"));
    expect(screen.getByTestId("fix-form")).toBeTruthy();
    expect(screen.queryByTestId("button-open-fix")).toBeNull();
    // The failed state keeps the form on the failure card, not the edit card.
    expect(screen.queryByTestId("card-edit-invoice")).toBeNull();
  });

  test("Escalate to my firm reveals the reason field", () => {
    renderWithClient(<InvoiceDetail />);
    expect(screen.queryByLabelText("What you've already tried")).toBeNull();
    fireEvent.click(screen.getByText("Escalate to my firm"));
    const reason = screen.getByLabelText("What you've already tried");
    expect(reason.id).toBe("escalate-reason");
    expect(screen.getByText("Send to firm")).toBeTruthy();
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByLabelText("What you've already tried")).toBeNull();
  });

  test("Retry transmission submits without re-validating", async () => {
    renderWithClient(<InvoiceDetail />);
    fireEvent.click(screen.getByText("Retry transmission"));
    fireEvent.click(screen.getByTestId("button-confirm-submit"));
    await waitFor(() =>
      expect(harness.calls.map((c) => c.name)).toEqual(["submit"]),
    );
  });
});

describe("stamped invoice", () => {
  beforeEach(() => {
    harness.invoice.data = detail({ status: "stamped" });
    harness.stamp = stamp();
  });

  test("the FIRS stamp card shows the IRN and CSID", () => {
    renderWithClient(<InvoiceDetail />);
    expect(screen.getByText(/FIRS\s+stamped/)).toBeTruthy();
    expect(screen.getByText("IRN-2026-0001")).toBeTruthy();
    expect(screen.getByText("CSID-ABCDEF")).toBeTruthy();
  });

  test("the action row offers a credit note and cancellation, no submit or edit", () => {
    renderWithClient(<InvoiceDetail />);
    expect(screen.getByTestId("button-credit-note")).toBeTruthy();
    expect(screen.getByTestId("button-cancel-invoice")).toBeTruthy();
    expect(screen.queryByTestId("button-edit-invoice")).toBeNull();
    expect(screen.queryByText("Submit for stamping")).toBeNull();
    expect(screen.queryByTestId("button-confirm-submit")).toBeNull();
  });

  test("the pin button toggles its pressed state", () => {
    renderWithClient(<InvoiceDetail />);
    const pin = screen.getByTestId("button-pin-invoice");
    expect(pin.getAttribute("aria-pressed")).toBe("false");
    expect(pin.textContent).toContain("Pin");
    fireEvent.click(pin);
    expect(
      screen.getByTestId("button-pin-invoice").getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByTestId("button-pin-invoice").textContent).toContain(
      "Pinned",
    );
    fireEvent.click(screen.getByTestId("button-pin-invoice"));
    expect(
      screen.getByTestId("button-pin-invoice").getAttribute("aria-pressed"),
    ).toBe("false");
  });
});

describe("line items", () => {
  test("lists each line with the total, and the naira equivalent for a USD invoice", () => {
    harness.invoice.data = detail({
      status: "stamped",
      currency: "USD",
      fxRateToNgn: "1500",
    });
    renderWithClient(<InvoiceDetail />);
    expect(screen.getByText("Line items")).toBeTruthy();
    expect(screen.getByText("Consulting retainer")).toBeTruthy();
    expect(screen.getByText("Total")).toBeTruthy();
    const equivalent = screen.getByTestId("text-total-ngn-equivalent");
    expect(equivalent.textContent).toContain("≈");
    expect(equivalent.textContent).toContain("per USD");
  });

  test("a naira invoice has no equivalent line", () => {
    harness.invoice.data = detail();
    renderWithClient(<InvoiceDetail />);
    expect(screen.queryByTestId("text-total-ngn-equivalent")).toBeNull();
  });
});

describe("New from this invoice", () => {
  const key = draftStorageKey("u-1", "f-1");

  test("seeds the invoice form's draft when nothing is stored", () => {
    harness.invoice.data = detail({ status: "stamped" });
    renderWithClient(<InvoiceDetail />);
    fireEvent.click(screen.getByTestId("button-new-from-invoice"));
    expect(screen.queryByTestId("button-confirm-new-from-invoice")).toBeNull();
    const { draft, restored } = loadInvoiceDraft(key);
    expect(restored).toBe(true);
    expect(draft.invoiceNumber).toBe("");
    expect(draft.buyerPartyId).toBe("buy-1");
    expect(draft.lines).toEqual([
      {
        description: "Consulting retainer",
        quantity: "2",
        unitPrice: "50000.00",
        vatRate: "0.075",
      },
    ]);
  });

  test("asks before replacing a stored draft that holds work", () => {
    saveInvoiceDraft(key, { ...emptyInvoiceDraft(), buyerPartyId: "buy-9" });
    harness.invoice.data = detail({ status: "stamped" });
    renderWithClient(<InvoiceDetail />);
    fireEvent.click(screen.getByTestId("button-new-from-invoice"));
    expect(screen.getByTestId("button-confirm-new-from-invoice")).toBeTruthy();
    // Nothing replaced until the dialog is confirmed.
    expect(loadInvoiceDraft(key).draft.buyerPartyId).toBe("buy-9");
    fireEvent.click(screen.getByTestId("button-confirm-new-from-invoice"));
    expect(loadInvoiceDraft(key).draft.buyerPartyId).toBe("buy-1");
  });
});
