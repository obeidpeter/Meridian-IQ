/**
 * Pure helpers behind the Month-end close screen: which existing mobile
 * screen (if any) a checklist item links to, and the header/row display
 * mapping. The checklist itself is computed server-side by the same checks
 * that power each advisory card (modules/invoice/month-end-close.ts) — this
 * module adds display logic only, never a predicate of its own. Kept free
 * of React Native imports so the node:test suite can exercise it directly
 * (the expo-router import is type-only and erased at runtime).
 */

import type { Href } from "expo-router";

// Item keys are the server's (month-end-close.ts). Only items whose detail
// lives on a screen this app HAS get a link; the rest render as plain rows
// — a link to nowhere is worse than no link. unmatched_collections has no
// mobile surface today.
const CLOSE_ITEM_ROUTES: Record<string, Href> = {
  // Overdue submissions and pending approvals are both invoice-list work.
  overdue_submissions: "/invoices",
  pending_approvals: "/invoices",
  // Vendor-bill items land on the supplier-bills ledger.
  missing_bills: "/bills",
  double_payments: "/bills",
  // Unmatched bank credits are reconciliation work.
  unmatched_credits: "/reconciliation",
  // A regular invoice not yet raised → draft one on the New Invoice tab.
  unbilled_income: "/invoice",
  // Open tax-authority obligations (Notice Desk) live on their own screen.
  open_obligations: "/obligations",
};

/**
 * The in-app route for a checklist item, or null when the item's surface is
 * web-only (or the key is from a newer server) — those rows render without
 * a link rather than dead-ending the user.
 */
export function closeItemRoute(key: string): Href | null {
  return CLOSE_ITEM_ROUTES[key] ?? null;
}

/**
 * The header pill: amber count while anything needs review, calm green
 * otherwise (the web card's exact vocabulary).
 */
export function closeHeaderPill(attentionCount: number): {
  label: string;
  tone: "warning" | "success";
} {
  return attentionCount > 0
    ? { label: `${attentionCount} to review`, tone: "warning" }
    : { label: "All clear", tone: "success" };
}

/** Row title: the label with its count appended only when non-zero. */
export function closeItemTitle(item: { label: string; count: number }): string {
  return item.count > 0 ? `${item.label} (${item.count})` : item.label;
}
