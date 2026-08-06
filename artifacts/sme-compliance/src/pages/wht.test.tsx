// @vitest-environment jsdom
// The WHT credits surface (WHT Desk): the credit ledger is written by the
// firm (record deduction, mark note received on the console) — the SME app
// only READS it. The server pins a client_user to its own party (no
// clientPartyId is sent); the page adds display logic only (the shared
// wht-copy labels and per-app pill tones — amber awaiting, emerald
// received). No note-marking buttons exist here by design.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { renderWithClient } from "../test-utils";
import type { WhtCredit, WhtCreditList } from "@workspace/api-client-react";

const harness = vi.hoisted(() => ({
  data: undefined as unknown,
  isLoading: false,
  isError: false,
  reset() {
    this.data = undefined;
    this.isLoading = false;
    this.isError = false;
  },
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useGetMe: () => ({ data: { capabilities: ["invoice.read"] } }),
    useListWhtCredits: () => ({
      data: harness.data,
      isLoading: harness.isLoading,
      isError: harness.isError,
      refetch: vi.fn(),
    }),
  };
});

// Import AFTER the mock so the page module binds the stand-ins.
import {
  WHT_CATEGORY_LABELS,
  WHT_CREDIT_STATUS_LABELS,
  Wht,
  whtBadgeClasses,
  whtCategoryLabel,
  whtCreditStatusLabel,
} from "./wht";

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

function list(
  credits: WhtCredit[],
  totals?: Partial<WhtCreditList["totals"]>,
): WhtCreditList {
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

const renderPage = () => renderWithClient(<Wht />);

afterEach(cleanup);
beforeEach(() => {
  harness.reset();
});

describe("display vocabulary", () => {
  test("label maps cover the server's closed catalogues, with fallbacks", () => {
    expect(Object.keys(WHT_CATEGORY_LABELS).sort()).toEqual([
      "commission_5",
      "goods_2",
      "rent_10",
      "royalties_10",
      "services_5",
      "works_2",
    ]);
    expect(whtCategoryLabel("services_5")).toBe(
      "Services & professional fees — 5%",
    );
    // Null reads as the honest default, and off-catalogue tokens from a
    // newer server degrade to a title-cased word.
    expect(whtCategoryLabel(null)).toBe("No WHT");
    expect(whtCategoryLabel("dividends_10")).toBe("Dividends 10");

    expect(Object.keys(WHT_CREDIT_STATUS_LABELS).sort()).toEqual([
      "awaiting_note",
      "note_received",
    ]);
    expect(whtCreditStatusLabel("awaiting_note")).toBe("Awaiting credit note");
    expect(whtCreditStatusLabel("note_received")).toBe("Credit note received");
  });

  test("pill tones: amber awaiting, emerald received, slate fallback", () => {
    expect(whtBadgeClasses("awaiting_note")).toContain("amber");
    expect(whtBadgeClasses("note_received")).toContain("emerald");
    expect(whtBadgeClasses("in_dispute")).toContain("slate");
  });
});

describe("WHT credits list", () => {
  test("rows show invoice, category label, amount, date and status pill", () => {
    harness.data = list(
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
    renderPage();

    const row1 = screen.getByTestId("row-wht-whc-1");
    expect(row1.textContent).toContain("INV-1001");
    expect(row1.textContent).toContain("Services & professional fees — 5%");
    expect(row1.textContent).toContain("7,500");
    expect(screen.getByTestId("pill-wht-whc-1").textContent).toBe(
      "Awaiting credit note",
    );
    expect(screen.getByTestId("pill-wht-whc-1").className).toContain("amber");

    // A received row carries its evidence reference alongside the pill.
    const row2 = screen.getByTestId("row-wht-whc-2");
    expect(row2.textContent).toContain("Rent & hire — 10%");
    expect(row2.textContent).toContain("Ref WHT/CN/44");
    expect(screen.getByTestId("pill-wht-whc-2").textContent).toBe(
      "Credit note received",
    );
    expect(screen.getByTestId("pill-wht-whc-2").className).toContain(
      "emerald",
    );
  });

  test("the totals strip counts awaiting (with the amount) and received", () => {
    harness.data = list(
      [credit(), credit({ id: "whc-2", status: "note_received" })],
      { awaitingNote: 1, noteReceived: 1, awaitingAmount: "7500.00" },
    );
    renderPage();
    const totals = screen.getByTestId("text-wht-totals");
    expect(totals.textContent).toContain("1 awaiting credit note");
    expect(totals.textContent).toContain("7,500");
    expect(totals.textContent).toContain("1 received");
  });

  test("read-only by design: no note-marking buttons for client users", () => {
    harness.data = list([credit()]);
    renderPage();
    expect(screen.queryByTestId("button-wht-note-whc-1")).toBeNull();
    expect(document.querySelector("table button")).toBeNull();
  });

  test("an empty ledger explains itself", () => {
    harness.data = list([], {
      awaitingNote: 0,
      noteReceived: 0,
      awaitingAmount: "0.00",
      totalAmount: "0.00",
    });
    renderPage();
    expect(screen.getByTestId("text-wht-empty").textContent).toBe(
      "No withholding credits yet",
    );
    expect(screen.queryByTestId("text-wht-totals")).toBeNull();
  });

  test("a failed fetch renders the shared error state", () => {
    harness.isError = true;
    renderPage();
    expect(screen.getByTestId("text-error").textContent).toBe(
      "Unable to load your WHT credits.",
    );
  });
});
