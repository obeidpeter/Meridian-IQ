// Which launch feature each month-end checklist lane belongs to. The server
// composes every detector regardless of the firm's release profile; the
// Today card shows only the lanes whose feature is lit for this account, so
// a launch-profile owner never reads a checklist about desks the nav hides.
// Keys not in the map are invoice-core and always shown.

export const CLOSE_ITEM_FEATURE: Readonly<Record<string, string>> = {
  open_filings: "statutory_desks",
  open_obligations: "statutory_desks",
  wht_credits: "statutory_desks",
  missing_bills: "money_analytics",
  double_payments: "money_analytics",
  unmatched_credits: "reconciliation",
  unmatched_collections: "collection_accounts",
};

export interface CloseItemLike {
  key: string;
  status: "clear" | "attention";
}

/** The checklist lanes visible for an account with these features. */
export function visibleCloseItems<T extends CloseItemLike>(
  items: readonly T[],
  features: readonly string[],
): T[] {
  const lit = new Set(features);
  return items.filter((item) => {
    const feature = CLOSE_ITEM_FEATURE[item.key];
    return feature === undefined || lit.has(feature);
  });
}

/** Attention count over the VISIBLE lanes — the header pill must agree with the list. */
export function closeAttentionCount(items: readonly CloseItemLike[]): number {
  return items.filter((item) => item.status === "attention").length;
}
