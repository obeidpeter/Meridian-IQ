import type { InvoiceLineInput } from "@workspace/api-client-react";
import Decimal from "decimal.js";

const FinancialDecimal = Decimal.clone({
  precision: 48,
  rounding: Decimal.ROUND_HALF_UP,
});

function previewDecimal(value: string): Decimal {
  const raw = value.trim();
  return /^\d+(?:\.\d+)?$/.test(raw) && raw.length <= 64
    ? new FinancialDecimal(raw)
    : new FinancialDecimal(0);
}

function decimalLineTotal(line: LineDraft) {
  const extension = previewDecimal(line.quantity).mul(
    previewDecimal(line.unitPrice),
  );
  // Match the server: VAT uses the unrounded extension, then each is rounded.
  const ext = extension.toDecimalPlaces(2);
  const vat = extension.mul(previewDecimal(line.vatRate)).toDecimalPlaces(2);
  return { ext, vat, total: ext.plus(vat) };
}

function normalizeDecimal(
  value: string,
  label: string,
  integerDigits: number,
  scale: number,
  positive = false,
): string {
  const raw = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(raw) || raw.length > integerDigits + scale + 2) {
    throw new Error(`${label} must be a finite decimal number.`);
  }
  const [whole, fraction = ""] = raw.split(".");
  if (
    whole.replace(/^0+/, "").length > integerDigits ||
    fraction.length > scale
  ) {
    throw new Error(`${label} exceeds the supported precision.`);
  }
  const decimal = new FinancialDecimal(raw);
  if (positive && decimal.isZero())
    throw new Error(`${label} must be greater than zero.`);
  return decimal.toFixed();
}

// Shared line-item form plumbing for the invoice form and the recurring
// template dialog (invoice-detail's "New from this invoice" seeds the same
// shape). Fields stay strings — they mirror the inputs while the user types;
// conversion to the contract shape happens once, in toInvoiceLineInputs.

/** Same standard rate every VAT select stores: the fraction string itself. */
export const VAT_STANDARD = "0.075";

export interface LineDraft {
  description: string;
  quantity: string;
  unitPrice: string;
  vatRate: string;
}

export const emptyLine = (): LineDraft => ({
  description: "",
  quantity: "1",
  unitPrice: "",
  vatRate: VAT_STANDARD,
});

export const todayIsoDate = (): string => new Date().toISOString().slice(0, 10);

/** Patch line i immutably, leaving every other row untouched. */
export function updateLineAt<T extends LineDraft>(
  lines: T[],
  i: number,
  patch: Partial<T>,
): T[] {
  return lines.map((l, idx) => (idx === i ? { ...l, ...patch } : l));
}

/** Extension and VAT for one row; empty inputs count as zero while typing. */
export function lineTotal(l: LineDraft): {
  ext: number;
  vat: number;
  total: number;
} {
  const { ext, vat, total } = decimalLineTotal(l);
  return { ext: ext.toNumber(), vat: vat.toNumber(), total: total.toNumber() };
}

/** Net/VAT sums across the drafted lines. */
export function lineTotals(lines: LineDraft[]): {
  net: number;
  vat: number;
  total: number;
} {
  let net = new FinancialDecimal(0);
  let vat = new FinancialDecimal(0);
  for (const line of lines) {
    const amounts = decimalLineTotal(line);
    net = net.plus(amounts.ext);
    vat = vat.plus(amounts.vat);
  }
  return {
    net: net.toNumber(),
    vat: vat.toNumber(),
    total: net.plus(vat).toNumber(),
  };
}

/**
 * A draft with an invoice number, a picked customer, or any filled-in line
 * is real work — the invoice form persists it (and shows its indicator),
 * and invoice-detail asks before replacing it. A corrupt draft reads as
 * empty.
 */
export function draftHasWork(d: {
  invoiceNumber?: string;
  buyerPartyId?: string;
  lines?: LineDraft[];
}): boolean {
  return Boolean(
    d.invoiceNumber?.trim() ||
    d.buyerPartyId ||
    (d.lines ?? []).some((l) => l?.description?.trim() || l?.unitPrice?.trim()),
  );
}

/**
 * Preserve every decimal digit in the contract payload, including large cents.
 * Only display totals are converted to JavaScript numbers.
 */
export function toInvoiceLineInputs(lines: LineDraft[]): InvoiceLineInput[] {
  return lines.map((l) => {
    const vatRate = normalizeDecimal(l.vatRate, "VAT rate", 1, 4);
    if (new FinancialDecimal(vatRate).gt(1)) {
      throw new Error("VAT rate must be a fraction between 0 and 1.");
    }
    return {
      description: l.description.trim(),
      quantity: normalizeDecimal(l.quantity, "Quantity", 14, 4, true),
      unitPrice: normalizeDecimal(l.unitPrice, "Unit price", 16, 2),
      vatRate,
    };
  });
}
