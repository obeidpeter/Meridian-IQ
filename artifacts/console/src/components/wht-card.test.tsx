// @vitest-environment jsdom
// The client page's "WHT credits" card (WHT Desk). The pins:
//  - The pill words come from the shared wht-copy vocabulary with
//    console-local tones (amber awaiting a note, emerald received), and the
//    category labels are the closed catalogue's wording — never raw enums.
//  - "Mark note received" opens one inline evidence panel (note date
//    defaults to today, the reference is required and trimmed), fires the
//    mutation with BOTH fields, and invalidates the credits list by its
//    real generated query key so all filtered variants (including the SME
//    app's twin) go stale together.
//  - Null-render: nothing before the credits list succeeds, and nothing for
//    an empty book (no credits AND no remittance rows) — the matrix-card
//    precedent. The remittance strip renders server strings and hides when
//    the period has no WHT-categorised bills.
//  - Actions gate on the invoice.write capability (the note route's own
//    assert — WHT credits are invoice-spine evidence): a read-only viewer sees
//    the ledger and its pills but no buttons that could only ever 403.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WhtCredit, WhtRemittance } from "@workspace/api-client-react";

// Controllable stand-ins for the generated hooks the card renders with. The
// rest of the module stays real — in particular the query-key builders, so
// the invalidation assertions compare against genuine keys.
const harness = vi.hoisted(() => ({
  credits: {
    data: undefined as unknown,
    isSuccess: false,
  },
  remittance: {
    data: undefined as unknown,
    isSuccess: false,
  },
  note: {
    calls: [] as unknown[],
    result: null as unknown,
  },
  capabilities: [] as string[],
  reset() {
    this.credits.data = undefined;
    this.credits.isSuccess = false;
    this.remittance.data = undefined;
    this.remittance.isSuccess = false;
    this.note.calls = [];
    this.note.result = null;
    this.capabilities = ["invoice.read", "invoice.write"];
  },
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  type MutationOpts = {
    mutation?: {
      onSuccess?: (data: unknown, vars: unknown) => void;
      onError?: (e: unknown) => void;
    };
  };
  return {
    ...actual,
    useGetMe: () => ({ data: { capabilities: harness.capabilities } }),
    useListWhtCredits: () => ({
      data: harness.credits.data,
      isSuccess: harness.credits.isSuccess,
    }),
    useGetWhtRemittance: () => ({
      data: harness.remittance.data,
      isSuccess: harness.remittance.isSuccess,
    }),
    useMarkWhtNoteReceived: (options?: MutationOpts) => ({
      isPending: false,
      mutate: (vars: unknown) => {
        harness.note.calls.push(vars);
        options?.mutation?.onSuccess?.(harness.note.result, vars);
      },
    }),
  };
});

// Import AFTER the mock so the component module binds the stand-ins.
import { WhtCard, whtCreditPill } from "./wht-card";
import { getListWhtCreditsQueryKey } from "@workspace/api-client-react";
import { localDayIso } from "@workspace/format/notice-copy";

function credit(over: Partial<WhtCredit> = {}): WhtCredit {
  return {
    id: "whc-1",
    firmId: "f-1",
    clientPartyId: "cp-1",
    invoiceId: "inv-1",
    invoiceNumber: "INV-1001",
    category: "services_5",
    amount: "7500.00",
    deductedDate: "2026-07-20",
    source: "manual",
    status: "awaiting_note",
    noteReference: null,
    noteDate: null,
    createdAt: "2026-07-20T10:00:00Z",
    updatedAt: "2026-07-20T10:00:00Z",
    ...over,
  };
}

function creditList(
  credits: WhtCredit[],
  totals: Partial<{
    awaitingNote: number;
    noteReceived: number;
    awaitingAmount: string;
    totalAmount: string;
  }> = {},
) {
  return {
    credits,
    totals: {
      awaitingNote: 1,
      noteReceived: 0,
      awaitingAmount: "7500.00",
      totalAmount: "7500.00",
      ...totals,
    },
  };
}

function remittance(over: Partial<WhtRemittance> = {}): WhtRemittance {
  return {
    period: "2026-07",
    periodLabel: "July 2026",
    dueDate: "2026-08-21",
    rows: [
      {
        invoiceId: "bill-1",
        invoiceNumber: "BILL-2001",
        vendorName: "Lagos Packaging Supplies Ltd",
        category: "goods_2",
        baseAmount: "100000.00",
        whtAmount: "2000.00",
        issueDate: "2026-07-15",
      },
    ],
    totals: { bills: 1, whtAmount: "2000.00" },
    ...over,
  };
}

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const spy = vi.spyOn(qc, "invalidateQueries").mockResolvedValue(undefined);
  const utils = render(
    <QueryClientProvider client={qc}>
      <WhtCard clientPartyId="cp-1" />
    </QueryClientProvider>,
  );
  return {
    container: utils.container,
    invalidatedKeys: () =>
      spy.mock.calls.map((c) => (c[0] as { queryKey: unknown }).queryKey),
  };
}

const click = (el: Element) =>
  act(async () => {
    fireEvent.click(el);
  });

afterEach(cleanup);
beforeEach(() => {
  harness.reset();
});

// ---- Pure helpers -----------------------------------------------------------

describe("whtCreditPill", () => {
  test("shared words, console-local tones, slate fallback", () => {
    expect(whtCreditPill("awaiting_note")).toEqual({
      tone: "amber",
      label: "Awaiting credit note",
    });
    expect(whtCreditPill("note_received")).toEqual({
      tone: "emerald",
      label: "Credit note received",
    });
    // An off-catalogue status from a newer server degrades to slate + a
    // title-cased word, never a crash.
    expect(whtCreditPill("in_dispute")).toEqual({
      tone: "slate",
      label: "In dispute",
    });
  });
});

// ---- The card ---------------------------------------------------------------

describe("WhtCard", () => {
  test("renders nothing before success, and nothing for an empty book", () => {
    const { container } = renderCard();
    expect(container.firstChild).toBeNull();
    cleanup();

    // Empty ledger AND an empty remittance schedule: no card.
    harness.credits.isSuccess = true;
    harness.credits.data = creditList([], {
      awaitingNote: 0,
      awaitingAmount: "0.00",
      totalAmount: "0.00",
    });
    harness.remittance.isSuccess = true;
    harness.remittance.data = remittance({
      rows: [],
      totals: { bills: 0, whtAmount: "0.00" },
    });
    const empty = renderCard();
    expect(empty.container.firstChild).toBeNull();
  });

  test("rows render the shared vocabulary, amounts, pills and totals", () => {
    harness.credits.isSuccess = true;
    harness.credits.data = creditList(
      [
        credit(),
        credit({
          id: "whc-2",
          invoiceNumber: "INV-1002",
          category: "rent_10",
          amount: "20000.00",
          status: "note_received",
          noteReference: "WHT/CN/44",
          noteDate: "2026-07-28",
        }),
      ],
      { awaitingNote: 1, noteReceived: 1, awaitingAmount: "7500.00" },
    );
    renderCard();

    const row1 = screen.getByTestId("row-wht-whc-1");
    expect(row1.textContent).toContain("INV-1001");
    expect(row1.textContent).toContain("Services & professional fees — 5%");
    expect(row1.textContent).toContain("7,500");
    expect(row1.textContent).toContain("withheld");
    expect(screen.getByTestId("pill-wht-whc-1").textContent).toBe(
      "Awaiting credit note",
    );
    expect(screen.getByTestId("pill-wht-whc-1").className).toContain("amber");

    // A received row carries its note evidence and offers no action.
    const row2 = screen.getByTestId("row-wht-whc-2");
    expect(row2.textContent).toContain("Rent & hire — 10%");
    expect(row2.textContent).toContain("Note WHT/CN/44");
    expect(screen.getByTestId("pill-wht-whc-2").className).toContain(
      "emerald",
    );
    expect(screen.queryByTestId("button-wht-note-whc-2")).toBeNull();

    const totals = screen.getByTestId("text-wht-totals");
    expect(totals.textContent).toContain("1 awaiting note");
    expect(totals.textContent).toContain("7,500");
    expect(totals.textContent).toContain("1 received");

    // The evidence-only foot.
    expect(screen.getByTestId("card-wht").textContent).toContain(
      "never claims or remits anything itself",
    );
  });

  test("the note walk: panel defaults today, sends trimmed reference + date, invalidates by the real key", async () => {
    harness.credits.isSuccess = true;
    harness.credits.data = creditList([credit()]);
    harness.note.result = credit({ status: "note_received" });
    const { invalidatedKeys } = renderCard();

    // Nothing expanded by default; the toggle opens the panel.
    expect(screen.queryByTestId("panel-wht-note-whc-1")).toBeNull();
    await click(screen.getByTestId("button-wht-note-whc-1"));
    expect(screen.getByTestId("panel-wht-note-whc-1")).toBeTruthy();

    const today = localDayIso(new Date());
    const dateInput = screen.getByTestId(
      "input-wht-note-date-whc-1",
    ) as HTMLInputElement;
    expect(dateInput.value).toBe(today);

    fireEvent.change(screen.getByTestId("input-wht-note-reference-whc-1"), {
      target: { value: "  WHT/CN/2026/07  " },
    });
    await click(screen.getByTestId("button-wht-note-confirm-whc-1"));
    expect(harness.note.calls).toEqual([
      {
        id: "whc-1",
        data: { noteReference: "WHT/CN/2026/07", noteDate: today },
      },
    ]);
    expect(invalidatedKeys()).toContainEqual(getListWhtCreditsQueryKey());
    // A success closes the panel.
    expect(screen.queryByTestId("panel-wht-note-whc-1")).toBeNull();
  });

  test("an empty reference holds the confirm — the contract requires both fields", async () => {
    harness.credits.isSuccess = true;
    harness.credits.data = creditList([credit()]);
    renderCard();

    await click(screen.getByTestId("button-wht-note-whc-1"));
    const confirm = screen.getByTestId(
      "button-wht-note-confirm-whc-1",
    ) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await click(confirm);
    expect(harness.note.calls).toEqual([]);

    // Clearing the date holds it too, even with a reference typed.
    fireEvent.change(screen.getByTestId("input-wht-note-reference-whc-1"), {
      target: { value: "WHT/CN/9" },
    });
    fireEvent.change(screen.getByTestId("input-wht-note-date-whc-1"), {
      target: { value: "" },
    });
    expect(confirm.disabled).toBe(true);
    await click(confirm);
    expect(harness.note.calls).toEqual([]);
  });

  test("the remittance strip renders the server's schedule verbatim", () => {
    harness.credits.isSuccess = true;
    harness.credits.data = creditList([credit()]);
    harness.remittance.isSuccess = true;
    harness.remittance.data = remittance();
    renderCard();

    const strip = screen.getByTestId("text-wht-remittance");
    expect(strip.textContent).toContain("1 bill");
    expect(strip.textContent).toContain("2,000");
    expect(strip.textContent).toContain("to remit for July 2026");
    expect(strip.textContent).toContain("due");
  });

  test("no remittance rows hides the strip; rows alone still earn the card", () => {
    // Credits present, empty schedule: ledger yes, strip no.
    harness.credits.isSuccess = true;
    harness.credits.data = creditList([credit()]);
    harness.remittance.isSuccess = true;
    harness.remittance.data = remittance({
      rows: [],
      totals: { bills: 0, whtAmount: "0.00" },
    });
    renderCard();
    expect(screen.getByTestId("card-wht")).toBeTruthy();
    expect(screen.queryByTestId("text-wht-remittance")).toBeNull();
    cleanup();

    // Empty ledger, bills on the schedule: the card renders for the strip.
    harness.credits.data = creditList([], {
      awaitingNote: 0,
      awaitingAmount: "0.00",
      totalAmount: "0.00",
    });
    harness.remittance.data = remittance();
    renderCard();
    expect(screen.getByTestId("card-wht")).toBeTruthy();
    expect(screen.getByTestId("text-wht-remittance")).toBeTruthy();
    expect(screen.queryByTestId("text-wht-totals")).toBeNull();
  });

  test("without invoice.write the ledger is read-only: pills, no buttons", () => {
    harness.capabilities = ["invoice.read"];
    harness.credits.isSuccess = true;
    harness.credits.data = creditList([credit()]);
    renderCard();

    expect(screen.getByTestId("pill-wht-whc-1").textContent).toBe(
      "Awaiting credit note",
    );
    expect(screen.queryByTestId("button-wht-note-whc-1")).toBeNull();
  });
});
