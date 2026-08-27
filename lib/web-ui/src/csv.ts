// Minimal RFC-4180 CSV helpers shared by the import surfaces (SME bulk
// invoice import, console client import). Spreadsheet exports (Excel,
// Sheets, practice-management tools) quote fields that contain commas —
// legal names, addresses, descriptions — so a naive split(",") corrupts
// them. DOM-free on purpose and exported via the "@workspace/web-ui/csv"
// subpath so node-environment tests and pure parsing modules can import it
// without pulling the React surface.

/**
 * Parse CSV text into a grid of cells. Handles quoted fields, escaped
 * quotes ("") and embedded commas/newlines inside quotes, plus both LF and
 * CRLF row endings. Rows whose cells are all blank are dropped. Cells are
 * NOT trimmed — callers own their whitespace policy.
 */
export function parseCsvTable(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      rows.push(row);
      row = [];
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/**
 * Encode one cell for CSV output: quoted (with "" escaping) only when the
 * value contains a comma, quote or newline, so simple values stay readable.
 */
export function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
