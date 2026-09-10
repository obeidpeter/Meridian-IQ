// Pure helpers for the SME bulk-import page (R126 split): the row ceiling,
// the CSV/Excel templates and their downloads, the workbook parser and the
// row-status pills. No React, no hooks. import-parse.ts stays at src/pages
// (its unit suite pins "./import-parse").
import { readSheet } from "read-excel-file/browser";
import writeXlsxFile from "write-excel-file/browser";
import type { InvoiceImportRow } from "@workspace/api-client-react";
import { COLUMNS, mapGridRows } from "../import-parse";

// Mirrors MAX_IMPORT_ROWS in the server route (routes/sme/import.ts): the
// server answers 413 above this, so surface the ceiling before anything is
// sent instead of after the upload fails.
export const MAX_IMPORT_ROWS = 5000;

export const TEMPLATE =
  COLUMNS.join(",") +
  "\n" +
  "INV-2001,Lagos Retail Ltd,12345678-0001,2026-07-01,2026-07-31,Consulting services,1,150000,0.075,NGN";

export function download(filename: string, text: string, mime = "text/csv") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export async function downloadExcelTemplate() {
  const header = COLUMNS.map((value) => ({
    value,
    type: String,
    fontWeight: "bold" as const,
  }));
  const example = [
    "INV-2001",
    "Lagos Retail Ltd",
    "12345678-0001",
    "2026-07-01",
    "2026-07-31",
    "Consulting services",
    "1",
    "150000",
    "0.075",
    "NGN",
  ].map((value) => ({ value, type: String }));
  await writeXlsxFile([header, example], { sheet: "Invoices" }).toFile(
    "valo-template.xlsx",
  );
}

// Parse the first sheet of an uploaded .xlsx workbook. The header row must use
// the same canonical column names as the CSV template so both formats map to the
// identical import-row model and run through the same server-side validator.
// read-excel-file replaces the unmaintained SheetJS build (prototype-pollution
// / ReDoS advisories) — it parses only the modern .xlsx (Office Open XML)
// container; legacy binary .xls is refused by name in onFile with guidance to
// re-save, because file.text() would "succeed" on it and produce garbage rows.
// The pure grid-to-row mapping lives in ./import-parse (mapGridRows) so it can
// be tested.
export async function parseWorkbook(file: Blob): Promise<InvoiceImportRow[]> {
  const grid = await readSheet(file);
  return mapGridRows(grid);
}

export const ROW_STATUS: Record<
  string,
  { label: string; tone: "emerald" | "red" | "slate" }
> = {
  valid: { label: "Valid", tone: "emerald" },
  created: { label: "Created", tone: "emerald" },
  invalid: { label: "Invalid", tone: "red" },
};
