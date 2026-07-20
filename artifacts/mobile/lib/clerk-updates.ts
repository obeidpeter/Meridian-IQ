/**
 * Pure helpers behind the "Digests & statements" screen: which updates
 * surface the signed-in principal gets (the server REFUSES the firm digest
 * to client_users, so the screen must branch by role and never call the
 * refused endpoint), plus display formatting for statement months and the
 * narrative-source note. Kept free of React Native imports so the node:test
 * suite can exercise them directly.
 */

export type UpdatesAudience = "firm" | "client";

/**
 * Which updates surface this principal gets:
 * - firm_admin/firm_staff holding clerk.ask → the firm's weekly digest
 *   (GET /clerk/digest is clerk.ask-gated, but 403s a client_user BY ROLE —
 *   the capability was widened to clients for Ask only, and the digest's
 *   facts span the whole client book, SEC-03 — so a client must never be
 *   routed to it, capability or not);
 * - client_user holding clerk.capture → their own monthly statements
 *   (GET /clerk/client-statements pins a client to their own party);
 * - anything else (platform roles, missing capability) → null: no Home
 *   tile, and the screen shows its locked state.
 */
export function updatesAudience(
  role: string | null | undefined,
  capabilities: readonly string[] | null | undefined,
): UpdatesAudience | null {
  const caps = capabilities ?? [];
  if (
    (role === "firm_admin" || role === "firm_staff") &&
    caps.includes("clerk.ask")
  ) {
    return "firm";
  }
  if (role === "client_user" && caps.includes("clerk.capture")) {
    return "client";
  }
  return null;
}

const STATEMENT_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/**
 * "2026-06-01" → "June 2026". String-split rather than Date parsing so the
 * Lagos month boundary the server computed can't shift a day in a device
 * timezone west of UTC (the SME dashboard's statement card does the same).
 * Malformed input degrades to the shared "—" placeholder or the raw token,
 * never NaN.
 */
export function statementMonthLabel(monthStart: string): string {
  const [y, m] = monthStart.split("-");
  if (!y || !m) return "—";
  return `${STATEMENT_MONTHS[Number(m) - 1] ?? m} ${y}`;
}

/**
 * Provenance line for a digest or statement narrative: the model only ever
 * phrases SQL-computed facts, and when it couldn't (kill switch, budget,
 * invalid output) the deterministic template answered instead. Unknown
 * sources from a newer server read as the template wording rather than
 * crashing or overclaiming.
 */
export function digestSourceNote(source: string): string {
  return source === "clerk" ? "Written by Clerk" : "Generated from your data";
}
