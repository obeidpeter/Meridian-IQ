import { formatNaira } from "@/lib/format";

// Receivables amounts arrive as decimal strings. NGN rows use the shared
// naira formatter; anything else gets a plain grouped number plus its
// currency code so a foreign-currency row never masquerades as naira.
const FOREIGN_AMOUNT_FORMAT = new Intl.NumberFormat("en-NG", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatMoney(value: string, currency: string): string {
  if (currency === "NGN") return formatNaira(value);
  const n = Number(value);
  if (Number.isNaN(n)) return "—";
  return `${FOREIGN_AMOUNT_FORMAT.format(n)} ${currency}`;
}
