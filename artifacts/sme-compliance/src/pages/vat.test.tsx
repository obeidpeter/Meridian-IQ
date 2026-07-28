// @vitest-environment jsdom
// The monthly VAT position (contract 0.45.0): output VAT from issued
// documents against input VAT from supplier bills, with the verified /
// unverified input split — only stamp-verified input VAT is defensible. The
// page renders the server's payload verbatim; the month picker refetches and
// the CSV export is a plain same-origin navigation.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { VatPosition } from "@workspace/api-client-react";

const harness = vi.hoisted(() => ({
  position: null as unknown,
  isLoading: false,
  isError: false,
  // Every params object useGetVatPosition was called with, in order.
  calls: [] as unknown[],
  reset() {
    this.position = null;
    this.isLoading = false;
    this.isError = false;
    this.calls = [];
  },
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useGetMe: () => ({ data: { clientPartyId: "cp-1" } }),
    useGetVatPosition: (params: unknown) => {
      harness.calls.push(params);
      return {
        data: harness.position,
        isLoading: harness.isLoading,
        isError: harness.isError,
        refetch: vi.fn(),
      };
    },
  };
});

// Import AFTER the mock so the page module binds the stand-ins.
import { Vat, fxExcludedLine, vatCsvHref, vatMonthLabel, vatRows } from "./vat";

function position(over: Partial<VatPosition> = {}): VatPosition {
  return {
    clientPartyId: "cp-1",
    monthStart: "2026-07-01",
    monthLabel: "July 2026",
    months: ["2026-07-01", "2026-06-01", "2026-05-01"],
    outputVat: "150000.00",
    outputInvoiceCount: 4,
    inputVat: "40000.00",
    inputVatVerified: "30000.00",
    inputVatUnverified: "10000.00",
    billCount: 3,
    netVat: "110000.00",
    defensibleNetVat: "120000.00",
    excludedForFx: 0,
    note: "Computed from your own documents — the Lagos calendar bounds the month.",
    ...over,
  };
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <Vat />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);
beforeEach(() => {
  harness.reset();
});

describe("VAT position summary", () => {
  test("renders the totals, the verified/unverified split and the note", () => {
    harness.position = position();
    renderPage();

    expect(screen.getByTestId("text-vat-output").textContent).toContain(
      "150,000.00",
    );
    expect(screen.getByTestId("text-vat-input").textContent).toContain(
      "40,000.00",
    );
    expect(screen.getByTestId("text-vat-input-verified").textContent).toContain(
      "30,000.00",
    );
    expect(
      screen.getByTestId("text-vat-input-unverified").textContent,
    ).toContain("10,000.00");
    expect(screen.getByTestId("text-vat-net").textContent).toContain(
      "110,000.00",
    );
    expect(screen.getByTestId("text-vat-defensible").textContent).toContain(
      "120,000.00",
    );
    expect(screen.getByTestId("text-vat-note").textContent).toContain(
      "Lagos calendar",
    );
  });

  test("a month with no documents shows the empty line instead of rows", () => {
    harness.position = position({
      outputInvoiceCount: 0,
      billCount: 0,
      outputVat: "0.00",
      inputVat: "0.00",
    });
    renderPage();
    expect(screen.getByTestId("text-vat-empty")).toBeTruthy();
    expect(screen.queryByTestId("text-vat-output")).toBeNull();
  });
});

describe("month picker", () => {
  test("offers the payload's months and refetches with the picked one", () => {
    harness.position = position();
    renderPage();

    const select = screen.getByTestId("select-vat-month") as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual([
      "2026-07-01",
      "2026-06-01",
      "2026-05-01",
    ]);
    // The default request carries no month — the server picks the current
    // Lagos month.
    expect(harness.calls[0]).toEqual({ clientPartyId: "cp-1" });

    fireEvent.change(select, { target: { value: "2026-06-01" } });
    expect(harness.calls.at(-1)).toEqual({
      clientPartyId: "cp-1",
      month: "2026-06-01",
    });
  });
});

describe("FX exclusion warning", () => {
  test("renders when documents were excluded, absent when none were", () => {
    harness.position = position({ excludedForFx: 2 });
    renderPage();
    expect(screen.getByTestId("text-vat-fx-excluded").textContent).toContain(
      "2 foreign-currency documents",
    );

    cleanup();
    harness.reset();
    harness.position = position({ excludedForFx: 0 });
    renderPage();
    expect(screen.queryByTestId("text-vat-fx-excluded")).toBeNull();
  });
});

describe("CSV export", () => {
  test("the button renders and the href pins the loaded month", () => {
    harness.position = position();
    renderPage();
    expect(screen.getByTestId("button-vat-csv")).toBeTruthy();
    expect(vatCsvHref("cp-1", "2026-07-01")).toBe(
      "/api/vat-position/export?clientPartyId=cp-1&month=2026-07-01",
    );
  });
});

describe("pure helpers", () => {
  test("vatMonthLabel names the month", () => {
    expect(vatMonthLabel("2026-06-01")).toBe("June 2026");
    expect(vatMonthLabel("2026-12-01")).toBe("December 2026");
  });

  test("fxExcludedLine pluralizes and stays quiet at zero", () => {
    expect(fxExcludedLine(0)).toBeNull();
    expect(fxExcludedLine(1)).toBe(
      "1 foreign-currency document without an exchange rate is excluded from these naira totals.",
    );
    expect(fxExcludedLine(3)).toBe(
      "3 foreign-currency documents without an exchange rate are excluded from these naira totals.",
    );
  });

  test("vatRows carries the six summary rows in reading order", () => {
    const rows = vatRows(position());
    expect(rows.map((r) => r.testId)).toEqual([
      "text-vat-output",
      "text-vat-input",
      "text-vat-input-verified",
      "text-vat-input-unverified",
      "text-vat-net",
      "text-vat-defensible",
    ]);
    expect(rows[0].label).toBe("Output VAT — 4 documents issued");
    expect(rows[1].label).toBe("Input VAT — 3 supplier bills");
  });
});
