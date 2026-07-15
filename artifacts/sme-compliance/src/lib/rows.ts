// Small pure helpers for the list pages' row plumbing, extracted from the
// identical copies in the invoice vault, recurring templates and B2C pages.

/** Build an id → display-string lookup from a nullable list. */
export function idMap<T>(
  items: T[] | null | undefined,
  id: (item: T) => string,
  value: (item: T) => string,
): Map<string, string> {
  const map = new Map<string, string>();
  (items || []).forEach((item) => map.set(id(item), value(item)));
  return map;
}

/**
 * Client-side mirror of the SEC-03 supplier scoping: a client_user sees only
 * rows where their own party is the supplier; firm users (no clientPartyId)
 * see every row the server returned.
 */
export function scopedToSupplier<T extends { supplierPartyId: string }>(
  rows: T[],
  clientPartyId: string | null | undefined,
): T[] {
  return rows.filter(
    (row) => !clientPartyId || row.supplierPartyId === clientPartyId,
  );
}
