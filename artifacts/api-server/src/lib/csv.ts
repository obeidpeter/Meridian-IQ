// Minimal, dependency-free CSV parser shared by ledger analysis (ADV-02) and
// bank-statement ingestion (INT-05): handles quoted fields, escaped quotes
// ("") and embedded commas/newlines.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

// The reverse direction, for export endpoints (invoice book, receivables
// aging, audit ledger): RFC-4180 quoting — cells containing a comma, quote or
// newline are quoted, quotes doubled. A leading BOM keeps Excel from mangling
// UTF-8.
export type CsvCell = string | number | null | undefined;

function serializeCell(value: CsvCell): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  // CSV formula injection (CWE-1236): a cell whose first character is a formula
  // trigger (= + - @, or a leading tab/CR the spreadsheet also treats as a
  // lead-in) is executed as a live formula when the file is opened in Excel /
  // LibreOffice / Sheets. These exports carry attacker-controllable free text
  // (invoice numbers, party legal names) and are opened by higher-privileged
  // firm staff and external auditors. Prefix such cells with an apostrophe so
  // the spreadsheet renders them as literal text. RFC-4180 quoting does NOT
  // prevent this — the quotes are stripped on import and "=..." still evaluates.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: CsvCell[][]): string {
  const lines = [header, ...rows].map((r) => r.map(serializeCell).join(","));
  return `﻿${lines.join("\r\n")}\r\n`;
}

// Ships a CSV as a file download — the Content-Type/Content-Disposition pair
// every export endpoint sends. Structurally typed so this module stays
// dependency-free (any express Response satisfies it).
export function sendCsvAttachment(
  res: {
    setHeader(name: string, value: string): unknown;
    send(body: string): unknown;
  },
  filename: string,
  csv: string,
): void {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(csv);
}
