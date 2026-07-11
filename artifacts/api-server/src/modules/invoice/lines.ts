// Pure invoice-line math and input plausibility guards. Kept free of DB
// imports so golden invariant tests can exercise them directly.
import { DomainError } from "../errors.ts";

export interface LineInput {
  description: string;
  quantity: string;
  unitPrice: string;
  vatRate: string; // fraction, e.g. "0.075"
}

export function money(n: number): string {
  return n.toFixed(2);
}

// vatRate is a FRACTION ("0.075" = 7.5%), never a percent ("7.5"). A client
// that sends percent-style rates would silently create 100x-inflated VAT
// (this bit the mobile quick-entry screen), so anything outside [0, 1] is
// rejected loudly at creation time.
export function vatRateError(vatRate: string): string | null {
  const raw = String(vatRate).trim();
  if (!raw) return "VAT rate is required";
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    return `VAT rate must be a fraction between 0 and 1 (e.g. "0.075" for 7.5%), got "${vatRate}" — percent-style rates are not accepted`;
  }
  return null;
}

export function assertPlausibleVatRates(lines: Pick<LineInput, "vatRate">[]): void {
  lines.forEach((line, idx) => {
    const err = vatRateError(line.vatRate);
    if (err) {
      throw new DomainError(
        "VAT_RATE_IMPLAUSIBLE",
        `Line ${idx + 1}: ${err}`,
        400,
      );
    }
  });
}

// Compute line financials from raw inputs.
export function computeLineFinancials(line: LineInput) {
  const qty = Number(line.quantity);
  const price = Number(line.unitPrice);
  const rate = Number(line.vatRate);
  const lineExtension = qty * price;
  const vatAmount = lineExtension * rate;
  return {
    lineExtension: money(lineExtension),
    vatAmount: money(vatAmount),
  };
}
