import type { InvoiceImportRow } from "@workspace/api-client-react";
import { parseCsvTable } from "@workspace/web-ui/csv";

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

// RFC-4180 parse (shared with the console's client import): quoted fields
// keep their commas/newlines, doubled quotes unescape, and rows that are
// entirely blank (including separator-only lines like ",,") are dropped
// before numbering, so rowNumber stays contiguous over real rows.
export function parseCsv(text: string): InvoiceImportRow[] {
  const table = parseCsvTable(text);
  if (table.length < 2) return [];
  const header = table[0].map((h) => h.trim());
  return table.slice(1).map((cells, idx) => {
    const row: Record<string, string> = {};
    header.forEach((h, i) => {
      row[h] = (cells[i] ?? "").trim();
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

// read-excel-file parses only the modern .xlsx (Office Open XML) container.
// A legacy binary .xls must therefore be refused by name up front (see
// isLegacyExcel) — the text/CSV branch would otherwise decode it into
// garbage rows that "load" and then drown the user in nonsense validation
// errors.
export function isExcel(name: string): boolean {
  return /\.xlsx$/i.test(name);
}

// Pre-2007 binary Excel. Not in the picker's accept list, but drag-and-drop
// and "All files" bypass accept, so the page guards by name too.
export function isLegacyExcel(name: string): boolean {
  return /\.xls$/i.test(name);
}
