// @vitest-environment jsdom
// The portfolio's "Filing cockpit" card (Filing Desk phase 3; WHT column
// since contract 0.69.0). The pins:
//  - Cell words come from the shared filing-copy vocabulary, with null (the
//    register hasn't minted that client's row) reading "Not minted" in a
//    muted italic — never a blank cell, never a raw enum. EXCEPT the WHT
//    column, where null is the common no-withholding-duty case and reads
//    the honest "No duty" instead.
//  - Table order is unfiled-most-urgent first: any null/"upcoming" cell
//    leads, prepared follows, all-filed sinks — client name breaks ties,
//    and the server's array is never mutated. A null WHT cell (no duty) is
//    NOT unstarted work and drops out of the urgency read; a minted WHT
//    row counts like any other.
//  - Self-gating render-on-success: no data, or a firm with no clients
//    (rows: []), renders nothing at all — no empty grid.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type {
  FilingMatrix,
  FilingMatrixRow,
} from "@workspace/api-client-react";

// Controllable stand-in for the generated hook the card renders with. The
// rest of the module stays real — in particular the query-key builder.
const harness = vi.hoisted(() => ({
  data: undefined as unknown,
  isSuccess: false,
  reset() {
    this.data = undefined;
    this.isSuccess = false;
  },
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useGetFilingMatrix: () => ({
      data: harness.data,
      isSuccess: harness.isSuccess,
    }),
  };
});

// Import AFTER the mock so the component module binds the stand-in.
import {
  FilingMatrixCard,
  matrixCellLabel,
  sortMatrixRows,
} from "./filing-matrix-card";

function row(over: Partial<FilingMatrixRow> = {}): FilingMatrixRow {
  return {
    clientPartyId: "cp-1",
    clientName: "Adaeze Foods",
    vat: "upcoming",
    paye: "upcoming",
    // The common WHT cell: no withholding duty this period.
    wht: null,
    ...over,
  };
}

function matrix(over: Partial<FilingMatrix> = {}): FilingMatrix {
  return {
    period: "2026-07",
    periodLabel: "July 2026",
    dueDates: { vat: "2026-08-21", paye: "2026-08-10", wht: "2026-08-21" },
    rows: [row()],
    totals: { clients: 1, filed: 0, unfiled: 2, overdue: 0 },
    ...over,
  };
}

afterEach(cleanup);
beforeEach(() => {
  harness.reset();
});

// ---- Pure helpers -----------------------------------------------------------

describe("matrixCellLabel", () => {
  test("shared vocabulary for real statuses; null reads Not minted", () => {
    expect(matrixCellLabel(null)).toBe("Not minted");
    expect(matrixCellLabel("upcoming")).toBe("Upcoming");
    expect(matrixCellLabel("prepared")).toBe("Prepared");
    expect(matrixCellLabel("filed")).toBe("Filed");
    // An off-catalogue status from a newer server degrades to a title-cased
    // word, never a crash.
    expect(matrixCellLabel("in_review")).toBe("In review");
  });

  test("the WHT column's null is the honest no-duty case, not Not minted", () => {
    expect(matrixCellLabel(null, "wht")).toBe("No duty");
    expect(matrixCellLabel(null, "paye")).toBe("Not minted");
    // A minted WHT row speaks the ordinary vocabulary.
    expect(matrixCellLabel("upcoming", "wht")).toBe("Upcoming");
    expect(matrixCellLabel("filed", "wht")).toBe("Filed");
  });
});

describe("sortMatrixRows", () => {
  test("unfiled-most-urgent first: null/upcoming, then prepared, then filed", () => {
    const sorted = sortMatrixRows([
      row({ clientPartyId: "cp-done", vat: "filed", paye: "filed" }),
      row({ clientPartyId: "cp-prep", vat: "prepared", paye: "filed" }),
      row({ clientPartyId: "cp-null", vat: null, paye: "filed" }),
      row({ clientPartyId: "cp-up", vat: "filed", paye: "upcoming" }),
    ]);
    // cp-null and cp-up share the unstarted bucket (same client name, so the
    // input order holds via the stable sort); prepared and filed follow.
    expect(sorted.map((r) => r.clientPartyId)).toEqual([
      "cp-null",
      "cp-up",
      "cp-prep",
      "cp-done",
    ]);
  });

  test("within a bucket the client name breaks the tie", () => {
    const sorted = sortMatrixRows([
      row({ clientPartyId: "cp-z", clientName: "Zenith Retail" }),
      row({ clientPartyId: "cp-a", clientName: "Adaeze Foods" }),
    ]);
    expect(sorted.map((r) => r.clientPartyId)).toEqual(["cp-a", "cp-z"]);
  });

  test("does not mutate the server's row order", () => {
    const rows = [
      row({ clientPartyId: "cp-done", vat: "filed", paye: "filed" }),
      row({ clientPartyId: "cp-up" }),
    ];
    sortMatrixRows(rows);
    expect(rows.map((r) => r.clientPartyId)).toEqual(["cp-done", "cp-up"]);
  });

  test("a null WHT cell (no duty) never reads unstarted; a minted one counts", () => {
    const sorted = sortMatrixRows([
      // All filed with no withholding duty: done — the null wht cell must
      // not drag the row back to unstarted the way a vat/paye null does.
      row({ clientPartyId: "cp-noduty", vat: "filed", paye: "filed", wht: null }),
      // All filed INCLUDING the WHT remittance: done as well (same client
      // name, so input order holds inside the bucket via the stable sort).
      row({
        clientPartyId: "cp-whtdone",
        vat: "filed",
        paye: "filed",
        wht: "filed",
      }),
      // Only the WHT remittance still upcoming: the minted row counts, so
      // the client leads as unstarted work.
      row({
        clientPartyId: "cp-whtup",
        vat: "filed",
        paye: "filed",
        wht: "upcoming",
      }),
      // WHT prepared with the rest filed: work in flight.
      row({
        clientPartyId: "cp-whtprep",
        vat: "filed",
        paye: "filed",
        wht: "prepared",
      }),
    ]);
    expect(sorted.map((r) => r.clientPartyId)).toEqual([
      "cp-whtup",
      "cp-whtprep",
      "cp-noduty",
      "cp-whtdone",
    ]);
  });
});

// ---- The card ---------------------------------------------------------------

describe("FilingMatrixCard", () => {
  test("renders nothing before success, and nothing for an empty book", () => {
    const { container } = render(<FilingMatrixCard />);
    expect(container.firstChild).toBeNull();
    cleanup();

    harness.isSuccess = true;
    harness.data = matrix({ rows: [] });
    const empty = render(<FilingMatrixCard />);
    expect(empty.container.firstChild).toBeNull();
  });

  test("a populated matrix: header, vocabulary cells, tones and totals", () => {
    harness.isSuccess = true;
    harness.data = matrix({
      rows: [
        row({
          clientPartyId: "cp-done",
          clientName: "Zenith Retail",
          vat: "filed",
          paye: "filed",
          wht: "filed",
        }),
        row({
          clientPartyId: "cp-mixed",
          clientName: "Adaeze Foods",
          vat: "prepared",
          paye: null,
          wht: null,
        }),
      ],
      totals: { clients: 2, filed: 3, unfiled: 1, overdue: 1 },
    });
    render(<FilingMatrixCard />);

    const card = screen.getByTestId("card-filing-matrix");
    // The server's periodLabel verbatim, and the due-date line speaks the
    // filing-kind vocabulary ("VAT return", not "VAT").
    expect(card.textContent).toContain("Filing cockpit — July 2026");
    expect(card.textContent).toContain("VAT return due");
    expect(card.textContent).toContain("PAYE remittance due");
    expect(card.textContent).toContain("WHT remittance due");

    // Unfiled-most-urgent first: the mixed row (a null cell) leads.
    const table = screen.getByTestId("table-filing-matrix");
    const bodyRows = Array.from(
      table.querySelectorAll("tbody tr"),
    ) as HTMLElement[];
    expect(bodyRows.map((r) => r.getAttribute("data-testid"))).toEqual([
      "row-filing-matrix-cp-mixed",
      "row-filing-matrix-cp-done",
    ]);

    // Cells: shared words, console-local tones, muted italic for null.
    const preparedCell = screen.getByTestId("cell-filing-vat-cp-mixed");
    expect(preparedCell.textContent).toBe("Prepared");
    expect(preparedCell.className).toContain("blue");
    const nullCell = screen.getByTestId("cell-filing-paye-cp-mixed");
    expect(nullCell.textContent).toBe("Not minted");
    expect(nullCell.className).toContain("italic");
    expect(nullCell.className).toContain("text-muted-foreground");
    const filedCell = screen.getByTestId("cell-filing-paye-cp-done");
    expect(filedCell.textContent).toBe("Filed");
    expect(filedCell.className).toContain("emerald");

    // The WHT column: null is the honest no-duty case (muted italic like
    // the other nulls, but its own words), and a filed remittance reads
    // the ordinary vocabulary in emerald.
    const noDutyCell = screen.getByTestId("cell-filing-wht-cp-mixed");
    expect(noDutyCell.textContent).toBe("No duty");
    expect(noDutyCell.className).toContain("italic");
    expect(noDutyCell.className).toContain("text-muted-foreground");
    const whtFiledCell = screen.getByTestId("cell-filing-wht-cp-done");
    expect(whtFiledCell.textContent).toBe("Filed");
    expect(whtFiledCell.className).toContain("emerald");

    // Totals line, with the non-zero overdue chunk painted red.
    const totals = screen.getByTestId("text-filing-matrix-totals");
    expect(totals.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "2 clients · 3 filed · 1 unfiled · 1 overdue",
    );
    expect(totals.querySelector("span")?.className).toContain("red");

    // The evidence-only foot.
    expect(card.textContent).toContain(
      "the platform never files anything itself",
    );
  });

  test("a zero overdue count is not painted red", () => {
    harness.isSuccess = true;
    harness.data = matrix();
    render(<FilingMatrixCard />);
    const totals = screen.getByTestId("text-filing-matrix-totals");
    expect(totals.textContent).toContain("0 overdue");
    expect(totals.querySelector("span")?.className ?? "").not.toContain("red");
  });
});
