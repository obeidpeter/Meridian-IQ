import type { InvoiceImportRow } from "@workspace/api-client-react";

// Pure, DOM-free parsing/mapping helpers for the bulk-import page. Extracted
// from import.tsx so they can be unit-tested without mounting the component or
// pulling in read-excel-file / browser APIs. Behaviour is unchanged — the page
// re-imports these and keeps the async file-reading (parseWorkbook) and the
// DOM download helpers.

// Canonical column order shared by the CSV and .xlsx templates so both formats
// map onto the identical import-row model and run through the same server-side
// validator.
export const COLUMNS = [
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
] as const;

// Coerce a raw parsed record into the import-row model: every cell becomes a
// trimmed string ("" for null/undefined), and the 0-based source index becomes
// a human 1-based rowNumber.
export function mapRow(
  row: Record<string, unknown>,
  idx: number,
): InvoiceImportRow {
  const cell = (k: string) => {
    const v = row[k];
    return v === undefined || v === null ? "" : String(v).trim();
  };
  return {
    rowNumber: idx + 1,
    invoiceNumber: cell("invoiceNumber"),
    buyerName: cell("buyerName"),
    buyerTin: cell("buyerTin"),
    issueDate: cell("issueDate"),
    dueDate: cell("dueDate"),
    description: cell("description"),
    quantity: cell("quantity"),
    unitPrice: cell("unitPrice"),
    vatRate: cell("vatRate"),
    currency: cell("currency"),
  } as InvoiceImportRow;
}

export function parseCsv(text: string): InvoiceImportRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line, idx) => {
    const cells = line.split(",");
    const row: Record<string, string> = {};
    header.forEach((h, i) => {
      row[h] = (cells[i] || "").trim();
    });
    return mapRow(row, idx);
  });
}

// The header-keyed row-mapping core of parseWorkbook, split out from the async
// read-excel-file call so it can be tested against a plain grid. The header row
// must use the same canonical column names as the CSV template.
export function mapGridRows(
  grid: readonly (readonly unknown[])[],
): InvoiceImportRow[] {
  if (grid.length < 2) return [];
  const header = grid[0].map((h) => String(h ?? "").trim());
  return grid.slice(1).map((cells, idx) => {
    const row: Record<string, unknown> = {};
    header.forEach((h, i) => {
      row[h] = cells[i];
    });
    return mapRow(row, idx);
  });
}

// read-excel-file parses only the modern .xlsx (Office Open XML) container, so
// a legacy binary .xls is NOT treated as Excel here — it falls through to the
// text/CSV path.
export function isExcel(name: string): boolean {
  return /\.xlsx$/i.test(name);
}
