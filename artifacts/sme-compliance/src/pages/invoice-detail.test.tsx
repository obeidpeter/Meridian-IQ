// @vitest-environment jsdom
// PaymentReminderCard's chase-ladder invariant: the reminder log records what
// the client actually SENT, and the next draft's stage keys off the row
// count — so a copy must log exactly once. Double-logging (e.g. two rapid
// copy clicks racing the first log's response) would falsely escalate the
// ladder's tone.
// Plus (contract 0.45.0) the maker-checker ApprovalsCard: informational for
// client users, actionable for firm roles, and the status-keyed submit title.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  Invoice,
  InvoiceApproval,
  PaymentChaserDraft,
} from "@workspace/api-client-react";

// Controllable stand-ins for the three generated hooks the card uses. The
// rest of the module stays real (the page imports many hooks; only these
// three render here).
const harness = vi.hoisted(() => ({
  draft: {
    data: undefined as PaymentChaserDraft | undefined,
    isPending: false,
    isError: false,
    mutateCalls: [] as unknown[],
  },
  log: {
    calls: [] as unknown[],
    pending: false,
    // Resolves the most recent in-flight log the way the server would.
    deliverSuccess: null as ((s: { stage: number }) => void) | null,
  },
  approvals: {
    data: undefined as unknown,
    isSuccess: false,
  },
  approve: {
    calls: [] as unknown[],
    pending: false,
  },
  reset() {
    this.draft.data = undefined;
    this.draft.isPending = false;
    this.draft.isError = false;
    this.draft.mutateCalls = [];
    this.log.calls = [];
    this.log.pending = false;
    this.log.deliverSuccess = null;
    this.approvals.data = undefined;
    this.approvals.isSuccess = false;
    this.approve.calls = [];
    this.approve.pending = false;
  },
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useDraftPaymentChaser: () => ({
      data: harness.draft.data,
      isPending: harness.draft.isPending,
      isError: harness.draft.isError,
      mutate: (vars: unknown) => harness.draft.mutateCalls.push(vars),
    }),
    useRecordChaseReminder: () => ({
      // Getter so the object handed to the click handler always reflects the
      // in-flight state, exactly like a live mutation object would.
      get isPending() {
        return harness.log.pending;
      },
      mutate: (
        vars: unknown,
        opts?: { onSuccess?: (s: { stage: number }) => void },
      ) => {
        harness.log.calls.push(vars);
        harness.log.pending = true;
        harness.log.deliverSuccess = (s) => {
          harness.log.pending = false;
          opts?.onSuccess?.(s);
        };
      },
    }),
    useListPaymentBehaviour: () => ({ data: undefined }),
    useListInvoiceApprovals: () => ({
      data: harness.approvals.data,
      isSuccess: harness.approvals.isSuccess,
    }),
    useApproveInvoice: () => ({
      isPending: harness.approve.pending,
      mutateAsync: (vars: unknown) => {
        harness.approve.calls.push(vars);
        return Promise.resolve({});
      },
    }),
  };
});

// Import AFTER the mock so the page module binds the stand-ins.
import {
  ApprovalsCard,
  PaymentReminderCard,
  canApproveInvoice,
  submitErrorTitle,
} from "./invoice-detail";

const invoice = {
  id: "inv-1",
  supplierPartyId: "sup-1",
  buyerPartyId: "buy-1",
} as unknown as Invoice;

function chaserDraft(stage: number): PaymentChaserDraft {
  return {
    invoiceId: "inv-1",
    invoiceNumber: "INV-001",
    buyerName: "Zenith Retail",
    subject: "Payment reminder for INV-001",
    body: "Please pay when you can.",
    source: "template",
    stage,
    previousReminders: { count: stage - 1, lastAt: null },
  };
}

function mockClipboard(writeText: () => Promise<void>) {
  Object.defineProperty(window.navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  return writeText;
}

const copyButton = () => screen.getByTestId("button-copy-chaser");

// Clicks run an async handler (clipboard write, then the log decision);
// act(async …) flushes the microtasks before assertions.
const click = (el: Element) =>
  act(async () => {
    fireEvent.click(el);
  });

afterEach(cleanup);
beforeEach(() => {
  harness.reset();
});

describe("PaymentReminderCard chase-ladder logging", () => {
  test("drafting and redrafting never log a reminder", async () => {
    const { rerender } = render(<PaymentReminderCard invoice={invoice} />);
    await click(screen.getByTestId("button-draft-chaser"));
    expect(harness.draft.mutateCalls).toHaveLength(1);
    expect(harness.log.calls).toHaveLength(0);

    // With a draft on screen, "Redraft" still logs nothing — only copying
    // (i.e. actually taking the letter to send) counts as a reminder.
    harness.draft.data = chaserDraft(1);
    rerender(<PaymentReminderCard invoice={invoice} />);
    await click(screen.getByText("Redraft"));
    expect(harness.draft.mutateCalls).toHaveLength(2);
    expect(harness.log.calls).toHaveLength(0);
  });

  test("copy logs once per stage, even across rapid clicks", async () => {
    mockClipboard(vi.fn(() => Promise.resolve()));
    harness.draft.data = chaserDraft(1);
    const { rerender } = render(<PaymentReminderCard invoice={invoice} />);

    await click(copyButton());
    expect(harness.log.calls).toEqual([{ invoiceId: "inv-1" }]);

    // Second copy while the first log is still in flight: the isPending
    // guard must hold the line (loggedStage only updates onSuccess, so it
    // alone would let this double-log).
    await click(copyButton());
    expect(harness.log.calls).toHaveLength(1);

    // The log lands; copying the same draft again still logs nothing more.
    act(() => harness.log.deliverSuccess?.({ stage: 1 }));
    await click(copyButton());
    expect(harness.log.calls).toHaveLength(1);

    // A redrafted next stage is a NEW reminder: copying it logs again.
    harness.draft.data = chaserDraft(2);
    rerender(<PaymentReminderCard invoice={invoice} />);
    await click(copyButton());
    expect(harness.log.calls).toHaveLength(2);
  });

  test("a denied clipboard skips the log (nothing was copied to send)", async () => {
    mockClipboard(vi.fn(() => Promise.reject(new Error("denied"))));
    harness.draft.data = chaserDraft(1);
    render(<PaymentReminderCard invoice={invoice} />);

    await click(copyButton());
    expect(harness.log.calls).toHaveLength(0);
    // No false "Copied" feedback either — the text stays on screen to copy
    // by hand.
    expect(copyButton().textContent).toBe("Copy to clipboard");
  });
});

// ---- Approvals card ---------------------------------------------------------

function approval(over: Partial<InvoiceApproval> = {}): InvoiceApproval {
  return {
    id: "ap-1",
    invoiceId: "inv-1",
    approvedByUserId: "u-2",
    approvedByName: "Ngozi Bello",
    note: "Checked the buyer TIN.",
    revokedAt: null,
    createdAt: "2026-07-20T10:00:00Z",
    ...over,
  };
}

function renderApprovals(role: string | undefined, status = "draft") {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ApprovalsCard invoiceId="inv-1" role={role} status={status} />
    </QueryClientProvider>,
  );
}

describe("ApprovalsCard", () => {
  test("renders each approval with approver, note and revoked state; client users get no approve button", () => {
    harness.approvals.isSuccess = true;
    harness.approvals.data = [
      approval(),
      approval({
        id: "ap-2",
        approvedByName: null,
        note: null,
        revokedAt: "2026-07-21T09:00:00Z",
      }),
    ];
    renderApprovals("client_user");

    const row1 = screen.getByTestId("row-approval-ap-1");
    expect(row1.textContent).toContain("Ngozi Bello");
    expect(row1.textContent).toContain("Checked the buyer TIN.");
    expect(screen.queryByTestId("pill-approval-revoked-ap-1")).toBeNull();

    // A nameless approver falls back to the user id; a revoked approval says
    // so instead of quietly disappearing.
    const row2 = screen.getByTestId("row-approval-ap-2");
    expect(row2.textContent).toContain("u-2");
    expect(screen.getByTestId("pill-approval-revoked-ap-2").textContent).toBe(
      "Revoked",
    );

    expect(screen.queryByTestId("button-approve-invoice")).toBeNull();
  });

  test("a firm member approves: the mutation fires with the invoice id", async () => {
    harness.approvals.isSuccess = true;
    harness.approvals.data = [];
    renderApprovals("firm_staff");

    fireEvent.click(screen.getByTestId("button-approve-invoice"));
    await waitFor(() => expect(harness.approve.calls).toHaveLength(1));
    expect(harness.approve.calls[0]).toEqual({ id: "inv-1" });
  });

  test("the approve button is disabled while the mutation is in flight", () => {
    harness.approvals.isSuccess = true;
    harness.approvals.data = [];
    harness.approve.pending = true;
    renderApprovals("firm_admin");
    expect(
      (screen.getByTestId("button-approve-invoice") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  test("render-on-success: no card before the list loads, and an empty ledger is only a card for approvers", () => {
    harness.approvals.isSuccess = false;
    renderApprovals("firm_admin");
    expect(screen.queryByTestId("card-approvals")).toBeNull();
    cleanup();

    // Empty + client user: nothing to say, nothing to do — no card.
    harness.approvals.isSuccess = true;
    harness.approvals.data = [];
    renderApprovals("client_user");
    expect(screen.queryByTestId("card-approvals")).toBeNull();
    cleanup();

    // Empty + firm role: the card explains what an approval is for.
    renderApprovals("firm_admin");
    expect(screen.getByTestId("text-no-approvals")).toBeTruthy();
  });
});

describe("canApproveInvoice", () => {
  test("firm roles only, and only while the invoice is still submittable", () => {
    for (const status of ["draft", "validated", "failed"]) {
      expect(canApproveInvoice("firm_admin", status)).toBe(true);
      expect(canApproveInvoice("firm_staff", status)).toBe(true);
      expect(canApproveInvoice("client_user", status)).toBe(false);
      expect(canApproveInvoice(undefined, status)).toBe(false);
    }
    // Once submitted/stamped there is nothing left to approve.
    for (const status of ["submitted", "stamped", "settled", "cancelled"]) {
      expect(canApproveInvoice("firm_admin", status)).toBe(false);
    }
  });
});

describe("submitErrorTitle", () => {
  test("a 409 is a deliberate refusal — 'blocked', not a generic error", () => {
    expect(submitErrorTitle(409)).toBe("Submission blocked");
    expect(submitErrorTitle(500)).toBe("Submission error");
    expect(submitErrorTitle(undefined)).toBe("Submission error");
  });
});
