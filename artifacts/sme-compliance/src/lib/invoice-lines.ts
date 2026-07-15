import type { InvoiceLineInput } from "@workspace/api-client-react";

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

export const todayIsoDate = (): string =>
  new Date().toISOString().slice(0, 10);

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
  const ext = Number(l.quantity || 0) * Number(l.unitPrice || 0);
  const vat = ext * Number(l.vatRate || 0);
  return { ext, vat, total: ext + vat };
}

/** Net/VAT sums across the drafted lines. */
export function lineTotals(lines: LineDraft[]): { net: number; vat: number } {
  return lines.reduce(
    (acc, l) => {
      const { ext, vat } = lineTotal(l);
      acc.net += ext;
      acc.vat += vat;
      return acc;
    },
    { net: 0, vat: 0 },
  );
}

/**
 * The contract payload: trimmed description, numbers normalized through
 * String(Number(...)) so "01" and "1.50" submit as "1" and "1.5".
 */
export function toInvoiceLineInputs(lines: LineDraft[]): InvoiceLineInput[] {
  return lines.map((l) => ({
    description: l.description.trim(),
    quantity: String(Number(l.quantity)),
    unitPrice: String(Number(l.unitPrice)),
    vatRate: String(Number(l.vatRate)),
  }));
}
