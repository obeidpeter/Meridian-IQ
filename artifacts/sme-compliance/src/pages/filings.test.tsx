// @vitest-environment jsdom
// The Filings surface (Filing Desk): the register is minted and walked by
// the firm on the console — the SME app only READS it. The server pins a
// client_user to its own party (no clientPartyId is sent); the page adds
// display logic only (the shared filing-copy labels, per-app status badges,
// and the client-side overdue/due-soon deadline flags on unfiled rows).
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { renderWithClient } from "../test-utils";
import type { Filing, ListFilingsParams } from "@workspace/api-client-react";

const harness = vi.hoisted(() => ({
  filings: [] as unknown[],
  listParams: [] as unknown[],
  isLoading: false,
  isError: false,
  reset() {
    this.filings = [];
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
    useGetMe: () => ({ data: { capabilities: ["filing.read"] } }),
    useListFilings: (params: ListFilingsParams) => {
      harness.listParams.push(params);
      return {
        data: { filings: harness.filings },
        isLoading: harness.isLoading,
        isError: harness.isError,
        refetch: vi.fn(),
      };
    },
  };
});

// Import AFTER the mock so the page module binds the stand-ins.
import {
  FILING_KIND_LABELS,
  FILING_STATUS_LABELS,
  Filings,
  deadlineFlag,
  filingKindLabel,
  filingPeriodLabel,
  filingStatusLabel,
  taxTypeLabel,
} from "./filings";

/** Local calendar day `offset` days from now, as YYYY-MM-DD. */
function isoDaysFromNow(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

function filing(over: Partial<Filing> = {}): Filing {
  return {
    id: "fil-1",
    firmId: "f-1",
    clientPartyId: "cp-1",
    taxType: "vat",
    period: "2026-07",
    dueDate: isoDaysFromNow(30),
    status: "upcoming",
    filedDate: null,
    filedReference: null,
    notes: null,
    preparedBy: null,
    filedBy: null,
    createdAt: "2026-08-01T10:00:00Z",
    updatedAt: "2026-08-01T10:00:00Z",
    ...over,
  };
}

const renderPage = () => renderWithClient(<Filings />);

afterEach(cleanup);
beforeEach(() => {
  harness.reset();
});

describe("display vocabulary", () => {
  test("label maps cover the server's closed catalogues, with fallbacks", () => {
    expect(Object.keys(FILING_STATUS_LABELS).sort()).toEqual([
      "filed",
      "prepared",
      "upcoming",
    ]);
    expect(Object.keys(FILING_KIND_LABELS).sort()).toEqual([
      "paye",
      "vat",
      "wht",
    ]);
    expect(filingKindLabel("vat")).toBe("VAT return");
    expect(filingKindLabel("paye")).toBe("PAYE remittance");
    expect(filingKindLabel("wht")).toBe("WHT remittance");
    expect(taxTypeLabel("vat")).toBe("VAT");
    // Off-catalogue tokens from a newer server degrade to a title-cased word.
    expect(filingKindLabel("wht_return")).toBe("Wht return");
    expect(filingStatusLabel("in_review")).toBe("In review");
  });

  test("status labels read as the filing lifecycle", () => {
    expect(filingStatusLabel("upcoming")).toBe("Upcoming");
    expect(filingStatusLabel("prepared")).toBe("Prepared");
    expect(filingStatusLabel("filed")).toBe("Filed");
  });

  test("periods read as months; junk input comes back verbatim", () => {
    expect(filingPeriodLabel("2026-07")).toBe("July 2026");
    expect(filingPeriodLabel("2025-12")).toBe("December 2025");
    expect(filingPeriodLabel("junk")).toBe("junk");
    expect(filingPeriodLabel("2026-13")).toBe("2026-13");
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

describe("filings list", () => {
  test("rows show the return's name, period, status badge and due date", () => {
    harness.filings = [
      filing(),
      filing({
        id: "fil-2",
        taxType: "paye",
        status: "filed",
        filedDate: "2026-08-05",
        filedReference: "FIRS/PAYE/77",
      }),
    ];
    renderPage();

    const row1 = screen.getByTestId("row-filing-fil-1");
    expect(row1.textContent).toContain("VAT return");
    expect(row1.textContent).toContain("July 2026");
    expect(row1.textContent).toContain("Due");
    expect(screen.getByTestId("badge-status-fil-1").textContent).toBe(
      "Upcoming",
    );

    // A filed row shows the evidence — filed date and reference — instead
    // of a deadline countdown.
    const row2 = screen.getByTestId("row-filing-fil-2");
    expect(row2.textContent).toContain("PAYE remittance");
    expect(row2.textContent).toContain("Ref FIRS/PAYE/77");
    expect(screen.getByTestId("badge-status-fil-2").textContent).toBe("Filed");
    expect(screen.getByTestId("text-due-fil-2").textContent).toContain(
      "Filed",
    );
  });

  test("an unfiled return past its due date wears the Overdue flag", () => {
    harness.filings = [
      filing({ dueDate: isoDaysFromNow(-1) }),
      filing({ id: "fil-2", dueDate: isoDaysFromNow(2) }),
      filing({ id: "fil-3", dueDate: isoDaysFromNow(30) }),
    ];
    renderPage();

    expect(screen.getByTestId("flag-deadline-fil-1").textContent).toBe(
      "Overdue",
    );
    expect(screen.getByTestId("flag-deadline-fil-2").textContent).toBe(
      "Due soon",
    );
    expect(screen.queryByTestId("flag-deadline-fil-3")).toBeNull();
  });

  test("a filed return never reads as overdue, even past its due date", () => {
    harness.filings = [
      filing({
        status: "filed",
        dueDate: isoDaysFromNow(-10),
        filedDate: isoDaysFromNow(-12),
      }),
    ];
    renderPage();
    expect(screen.queryByTestId("flag-deadline-fil-1")).toBeNull();
  });

  test("filters default to upcoming and switch the status param (all sends none)", () => {
    harness.filings = [filing()];
    renderPage();
    expect(harness.listParams[0]).toEqual({ status: "upcoming" });

    fireEvent.click(screen.getByTestId("filter-filings-filed"));
    expect(harness.listParams.at(-1)).toEqual({ status: "filed" });

    fireEvent.click(screen.getByTestId("filter-filings-all"));
    expect(harness.listParams.at(-1)).toEqual({});
  });

  test("an empty filtered list explains itself and offers the all view", () => {
    renderPage();
    expect(screen.getByTestId("text-empty").textContent).toBe(
      "No upcoming filings",
    );
    fireEvent.click(screen.getByTestId("button-show-all-filings"));
    expect(harness.listParams.at(-1)).toEqual({});
    expect(screen.getByTestId("text-empty").textContent).toBe(
      "No filings tracked",
    );
    expect(screen.queryByTestId("button-show-all-filings")).toBeNull();
  });

  test("a failed fetch renders the shared error state", () => {
    harness.isError = true;
    renderPage();
    expect(screen.getByTestId("text-error").textContent).toBe(
      "Unable to load your filings.",
    );
  });
});
