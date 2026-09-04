import { FinancialDecimal } from "./lines";

export function invoiceNgnEquivalent(invoice: {
  currency: string;
  grandTotal: string;
  fxRateToNgn: string | null;
}): string {
  if (invoice.currency === "NGN") return invoice.grandTotal;
  if (!invoice.fxRateToNgn) return "";
  const amount = new FinancialDecimal(invoice.grandTotal);
  const rate = new FinancialDecimal(invoice.fxRateToNgn);
  if (!amount.isFinite() || !rate.isFinite() || rate.lte(0)) return "";
  return amount.mul(rate).toFixed(2);
}
