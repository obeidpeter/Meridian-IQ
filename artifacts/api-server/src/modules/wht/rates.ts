// WHT Desk: the closed withholding-rate catalogue — the ONE home for "which
// category withholds how much" (2025 Deduction at Source regulations,
// corporate recipients). Keys mirror the contract's whtCategory enum; rates
// are BASIS POINTS so the arithmetic stays integer until the final rounding.
// Display labels deliberately do NOT live here: they are frontend vocabulary
// (@workspace/format/wht-copy), and the api-server imports no
// @workspace/format package (the filing-matrix precedent) — this module is
// the arithmetic side of that split.
//
// Expected WHT = round(subtotal × bps / 10000, 2) — the VAT-EXCLUSIVE base
// (invoices.subtotal): a buyer withholds on the value of the supply, never on
// the VAT the supplier merely collects.
import { sql, type SQL } from "drizzle-orm";

export const WHT_RATES_BPS: Record<string, number> = {
  goods_2: 200,
  works_2: 200,
  services_5: 500,
  commission_5: 500,
  rent_10: 1000,
  royalties_10: 1000,
};

/** The catalogue's basis-point rate, or null for a null/unknown category. */
export function whtRateBps(category: string | null | undefined): number | null {
  if (category === null || category === undefined) return null;
  return WHT_RATES_BPS[category] ?? null;
}

/**
 * SQL CASE fragment computing the expected WHT for a (subtotal, category)
 * column pair: round(subtotal × bps / 10000, 2), NULL for a category outside
 * the catalogue (or NULL). EVERY expected-WHT computation — the credits
 * ledger's default amount, the remittance schedule, the reconciliation
 * short-pay candidates and the accept-time mint — interpolates THIS builder,
 * so no two surfaces can disagree about what a buyer should have withheld.
 * Callers pass their own column spellings (aliased `i.subtotal` raw fragments
 * or drizzle column refs) so the fragment composes in both query styles.
 */
export function whtExpectedSql(subtotal: SQL, category: SQL): SQL {
  const arms = Object.entries(WHT_RATES_BPS).map(
    ([key, bps]) =>
      sql` WHEN ${key} THEN round(${subtotal} * ${sql.raw(String(bps))} / 10000.0, 2)`,
  );
  return sql`(CASE ${category}${sql.join(arms, sql``)} ELSE NULL END)`;
}
