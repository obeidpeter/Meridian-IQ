/**
 * Shared draft-line model and pure parsing/normalization helpers for the
 * invoice forms (create tab and the fix-invoice screen).
 */

import type { InvoiceLineInput } from "@workspace/api-client-react";

export interface LineDraft {
  key: string;
  description: string;
  quantity: string;
  unitPrice: string;
  vatRate: string; // percent, e.g. "7.5"
}

// Per-line inline numeric errors, keyed by line.key.
export type LineErrors = Record<
  string,
  { quantity?: string; unitPrice?: string }
>;

// A fresh, empty draft line at the default Nigerian VAT rate. Key generation
// stays with the caller — each screen has its own uniqueness scheme.
export function blankLine(key: string): LineDraft {
  return {
    key,
    description: "",
    quantity: "1",
    unitPrice: "",
    vatRate: "7.5",
  };
}

export function num(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// Parse a user-entered numeric string: trims, coerces a decimal comma to a dot
// (common on many locales/keyboards), and returns a finite number or null.
export function parseNumeric(value: string): number | null {
  const normalized = value.trim().replace(",", ".");
  if (normalized === "") return null;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

// Validate a YYYY-MM-DD calendar date locally (rejects e.g. 2024-02-31) so the
// user gets immediate feedback instead of a server round-trip.
export function isValidISODate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === value;
}

// Subtotal/VAT/grand total across the drafted lines (vatRate is a percent).
export function computeTotals(lines: LineDraft[]): {
  subtotal: number;
  vat: number;
  grand: number;
} {
  let subtotal = 0;
  let vat = 0;
  for (const line of lines) {
    const ext = num(line.quantity) * num(line.unitPrice);
    subtotal += ext;
    vat += (ext * num(line.vatRate)) / 100;
  }
  return { subtotal, vat, grand: subtotal + vat };
}

// Build the API line payload from normalized numerics and collect per-line
// inline errors for anything non-finite/empty. Lines with an empty (trimmed)
// description are dropped; every kept line yields exactly one payload entry.
// The API stores VAT as a fraction (0.075) while the form edits a percent,
// hence the /100.
export function normalizeLines(lines: LineDraft[]): {
  payloadLines: InvoiceLineInput[];
  lineErrs: LineErrors;
} {
  const lineErrs: LineErrors = {};
  const payloadLines: InvoiceLineInput[] = [];
  for (const l of lines) {
    if (!l.description.trim()) continue;
    const qty = parseNumeric(l.quantity);
    const price = parseNumeric(l.unitPrice);
    const rate = parseNumeric(l.vatRate) ?? 0;
    const errs: { quantity?: string; unitPrice?: string } = {};
    if (qty === null || qty <= 0) {
      errs.quantity = "Enter a quantity greater than 0.";
    }
    if (price === null || price < 0) {
      errs.unitPrice = "Enter a valid unit price.";
    }
    if (errs.quantity || errs.unitPrice) lineErrs[l.key] = errs;
    payloadLines.push({
      description: l.description.trim(),
      quantity: String(qty ?? 0),
      unitPrice: String(price ?? 0),
      vatRate: String(rate / 100),
    });
  }
  return { payloadLines, lineErrs };
}
