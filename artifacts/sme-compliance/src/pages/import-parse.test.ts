import { test, expect, describe } from "vitest";
import {
  COLUMNS,
  parseCsv,
  mapRow,
  mapGridRows,
  isExcel,
} from "./import-parse";

describe("COLUMNS", () => {
  test("is the canonical import column order", () => {
    expect(COLUMNS).toEqual([
      "invoiceNumber",
      "buyerName",
      "buyerTin",
      "issueDate",
      "dueDate",
      "description",
      "quantity",
      "unitPrice",
      "vatRate",
      "currency",
    ]);
  });
});

describe("mapRow", () => {
  test("sets rowNumber to idx + 1 (0-based source → 1-based human row)", () => {
    expect(mapRow({}, 0).rowNumber).toBe(1);
    expect(mapRow({}, 4).rowNumber).toBe(5);
  });

  test("coerces null / undefined / missing cells to empty strings", () => {
    const row = mapRow({ invoiceNumber: null, buyerName: undefined }, 0);
    expect(row.invoiceNumber).toBe("");
    expect(row.buyerName).toBe("");
    // A key never present in the record is also "".
    expect(row.currency).toBe("");
  });

  test("coerces non-string cell values to trimmed strings", () => {
    const row = mapRow({ quantity: 5, unitPrice: 150000 }, 0);
    expect(row.quantity).toBe("5");
    expect(row.unitPrice).toBe("150000");
  });

  test("trims surrounding whitespace on string cells", () => {
    const row = mapRow({ invoiceNumber: "  INV-1  " }, 0);
    expect(row.invoiceNumber).toBe("INV-1");
  });
});

describe("parseCsv", () => {
  test("maps a header row onto the import-row model by column name", () => {
    const csv =
      "invoiceNumber,buyerName,buyerTin,issueDate,dueDate,description,quantity,unitPrice,vatRate,currency\n" +
      "INV-2001,Lagos Retail Ltd,12345678-0001,2026-07-01,2026-07-31,Consulting services,1,150000,0.075,NGN";
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      rowNumber: 1,
      invoiceNumber: "INV-2001",
      buyerName: "Lagos Retail Ltd",
      buyerTin: "12345678-0001",
      issueDate: "2026-07-01",
      dueDate: "2026-07-31",
      description: "Consulting services",
      quantity: "1",
      unitPrice: "150000",
      vatRate: "0.075",
      currency: "NGN",
    });
  });

  test("returns [] when there are fewer than 2 non-blank lines", () => {
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv("invoiceNumber,buyerName")).toEqual([]);
    // Blank lines do not count toward the 2-line minimum.
    expect(parseCsv("invoiceNumber,buyerName\n\n   \n")).toEqual([]);
  });

  test("skips blank / whitespace-only lines and keeps rowNumber contiguous", () => {
    const csv =
      "invoiceNumber,quantity\n" +
      "\n" +
      "INV-1,1\n" +
      "   \n" +
      "INV-2,2\n";
    const rows = parseCsv(csv);
    expect(rows.map((r) => r.invoiceNumber)).toEqual(["INV-1", "INV-2"]);
    // First surviving data row is rowNumber 1, not 2 — blanks were filtered
    // before indexing.
    expect(rows.map((r) => r.rowNumber)).toEqual([1, 2]);
  });

  test("trims the header names and each cell value", () => {
    const csv =
      "  invoiceNumber , buyerName \n" + "  INV-9  ,  Ada Traders  ";
    const rows = parseCsv(csv);
    expect(rows[0].invoiceNumber).toBe("INV-9");
    expect(rows[0].buyerName).toBe("Ada Traders");
  });

  test("maps values by header name regardless of column order", () => {
    const csv = "buyerName,invoiceNumber\nAda Traders,INV-9";
    const rows = parseCsv(csv);
    expect(rows[0].invoiceNumber).toBe("INV-9");
    expect(rows[0].buyerName).toBe("Ada Traders");
  });

  test("fills missing trailing cells with empty strings", () => {
    const csv = "invoiceNumber,buyerName,currency\nINV-1";
    const rows = parseCsv(csv);
    expect(rows[0].invoiceNumber).toBe("INV-1");
    expect(rows[0].buyerName).toBe("");
    expect(rows[0].currency).toBe("");
  });

  test("ignores cells and columns outside the known model", () => {
    // Extra trailing cell beyond the header is dropped; an unknown header
    // column is parsed into the record but never read by mapRow.
    const csv = "invoiceNumber,note\nINV-1,hello,EXTRA";
    const rows = parseCsv(csv);
    expect(rows[0].invoiceNumber).toBe("INV-1");
    expect(rows[0]).not.toHaveProperty("note");
  });

  test("splits on both LF and CRLF line endings", () => {
    const csv = "invoiceNumber,quantity\r\nINV-1,1\r\nINV-2,2";
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[1].invoiceNumber).toBe("INV-2");
  });
});

describe("mapGridRows (workbook mapping core)", () => {
  test("maps a header + data grid, coercing raw cell types to strings", () => {
    const grid = [
      ["invoiceNumber", "quantity", "unitPrice"],
      ["INV-1", 3, 150000],
    ];
    const rows = mapGridRows(grid);
    expect(rows).toHaveLength(1);
    expect(rows[0].rowNumber).toBe(1);
    expect(rows[0].invoiceNumber).toBe("INV-1");
    expect(rows[0].quantity).toBe("3");
    expect(rows[0].unitPrice).toBe("150000");
  });

  test("returns [] for a grid with fewer than 2 rows", () => {
    expect(mapGridRows([])).toEqual([]);
    expect(mapGridRows([["invoiceNumber", "quantity"]])).toEqual([]);
  });

  test("coerces null cells to empty strings and numbers rowNumbers from 1", () => {
    const grid = [
      ["invoiceNumber", "buyerName"],
      ["INV-1", null],
      [null, "Ada Traders"],
    ];
    const rows = mapGridRows(grid);
    expect(rows.map((r) => r.rowNumber)).toEqual([1, 2]);
    expect(rows[0].buyerName).toBe("");
    expect(rows[1].invoiceNumber).toBe("");
    expect(rows[1].buyerName).toBe("Ada Traders");
  });
});

describe("isExcel", () => {
  test("treats only a .xlsx extension as Excel (case-insensitive)", () => {
    expect(isExcel("invoices.xlsx")).toBe(true);
    expect(isExcel("INVOICES.XLSX")).toBe(true);
    expect(isExcel("Mixed.XlSx")).toBe(true);
  });

  test("does not treat legacy .xls or .csv as Excel", () => {
    expect(isExcel("invoices.xls")).toBe(false);
    expect(isExcel("invoices.csv")).toBe(false);
    expect(isExcel("invoices.txt")).toBe(false);
  });

  test("only matches .xlsx anchored at the end of the name", () => {
    expect(isExcel("invoices.xlsx.csv")).toBe(false);
    expect(isExcel("report.xlsxx")).toBe(false);
    expect(isExcel("xlsx")).toBe(false);
    expect(isExcel("a.xlsx.xlsx")).toBe(true);
  });
});
