/**
 * Shared draft-line model and pure parsing/normalization helpers for the
 * invoice forms (create tab and the fix-invoice screen).
 */

import type { InvoiceLineInput } from "@workspace/api-client-react";
import Decimal from "decimal.js";
const FinancialDecimal = Decimal.clone({
  precision: 48,
  rounding: Decimal.ROUND_HALF_UP,
});

function exactDecimal(value: string): Decimal | null {
  const normalized = value.trim().replace(",", ".");
  if (normalized.length > 128 || !/^-?\d+(?:\.\d+)?$/.test(normalized))
    return null;
  return new FinancialDecimal(normalized);
}

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
  { quantity?: string; unitPrice?: string; vatRate?: string }
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
  if (Number(value.slice(0, 4)) < 1) return false;
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
  let subtotal = new FinancialDecimal(0);
  let vat = new FinancialDecimal(0);
  for (const line of lines) {
    const ext = (exactDecimal(line.quantity) ?? new FinancialDecimal(0)).mul(
      exactDecimal(line.unitPrice) ?? 0,
    );
    subtotal = subtotal.plus(ext.toDecimalPlaces(2));
    vat = vat.plus(
      ext
        .mul(exactDecimal(line.vatRate) ?? 0)
        .div(100)
        .toDecimalPlaces(2),
    );
  }
  return {
    subtotal: subtotal.toNumber(),
    vat: vat.toNumber(),
    grand: subtotal.plus(vat).toNumber(),
  };
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
    const qty = exactDecimal(l.quantity);
    const price = exactDecimal(l.unitPrice);
    const rate = exactDecimal(l.vatRate || "0");
    const errs: LineErrors[string] = {};
    if (qty === null || qty.lte(0)) {
      errs.quantity = "Enter a quantity greater than 0.";
    } else if (qty.gte("100000000000000") || qty.decimalPlaces() > 4) {
      errs.quantity =
        "Quantity supports up to 14 integer digits and 4 decimal places.";
    }
    if (price === null || price.lt(0)) {
      errs.unitPrice = "Enter a valid unit price.";
    } else if (price.gte("10000000000000000") || price.decimalPlaces() > 2) {
      errs.unitPrice =
        "Price supports up to 16 integer digits and 2 decimal places.";
    }
    if (
      rate === null ||
      rate.lt(0) ||
      rate.gt(100) ||
      rate.decimalPlaces() > 2
    ) {
      errs.vatRate =
        "Enter a VAT percentage between 0 and 100, with up to 2 decimal places.";
    }
    if (Object.keys(errs).length) lineErrs[l.key] = errs;
    payloadLines.push({
      description: l.description.trim(),
      quantity: qty?.toFixed() ?? "0",
      unitPrice: price?.toFixed() ?? "0",
      vatRate: rate?.div(100).toFixed() ?? "0",
    });
  }
  return { payloadLines, lineErrs };
}
