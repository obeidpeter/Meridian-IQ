// Day-granular date arithmetic and the plain median, shared by the invoice
// history miners (cashflow, unbilled-income, recurring-suggest, line-items,
// payment-behaviour, projection-accuracy). Dates are YYYY-MM-DD calendar
// strings treated as UTC midnights — the miners compare Lagos calendar days,
// never wall-clock instants, so a fixed 86 400 000 ms day is exact.

export function addDays(dateString: string, days: number): string {
  const d = new Date(`${dateString}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round(
    (new Date(`${b}T00:00:00Z`).getTime() -
      new Date(`${a}T00:00:00Z`).getTime()) /
      86_400_000,
  );
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

// The shared trailing-year evidence window every history miner uses
// (recurring suggestions, unbilled income, missing bills, payment
// behaviour, line-item memory, chase effectiveness) — ONE home
// (refactoring round), so the window that feeds cash-flow projections and
// the chase list cannot fork per miner.
export const LOOKBACK_DAYS = 365;
