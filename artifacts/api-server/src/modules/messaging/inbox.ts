import { desc, eq } from "drizzle-orm";
import { getDb, messagesTable } from "@workspace/db";
import type { Principal } from "../auth/rbac";
import { pointerEntityRef, recipientRefFor } from "./recipient-ref";
import { TEMPLATES } from "./messaging";

// Notification inbox: the messages ledger read from the RECIPIENT's side.
// Every alert the platform sends lands one pointer-only row in `messages`
// (SEC-12) addressed to an opaque recipientRef minted by recipient-ref.ts.
// This module resolves the signed-in principal to the ONE ref that names it
// and returns its rows, newest first.
//
// Scoping (SEC-03): `messages` has NO firm key and NO RLS policy — it is a
// platform-wide pointer ledger — so the recipient_ref equality below IS the
// isolation wall. Firm-keyed RLS could not help here anyway (the table has no
// firm column), and it would not be a sibling wall even if it could: two
// client_users of the same firm share the firm's RLS scope, so the per-party
// ref equality is what keeps sibling clients out of each other's feeds.
//
// Per-role resolution:
//  - client_user  → recipientRefFor(clientPartyId) (`ref-…`), the ref every
//    party-scoped alert rail (fan-out.ts, reminders, B2C, statements) sends to.
//  - firm_admin / firm_staff → pointerEntityRef("usr", userId) (`usr-…`), the
//    ref the staff-preference rails (digest delivery, push) send to. Staff
//    deliberately do NOT also see their firm's party-ref rows: a party alert
//    belongs to the CLIENT it was addressed to — surfacing it in a staff feed
//    would leak per-client alert traffic to every teammate and turn the feed
//    into a firm-wide monitor, which the operator message log (GET /messages)
//    already is, behind its own operator gate.
//  - operator / auditor / bank_user / buyer_user → empty feed: no send rail
//    mints a recipientRef for these roles, so the ledger simply has no
//    recipient identity for them to claim.

export interface NotificationItem {
  id: string;
  channel: string;
  templateKey: string;
  title: string;
  entityType: string | null;
  entityId: string | null;
  status: string;
  createdAt: string;
}

// The ledger row is pointer-only and STAYS pointer-only in the feed: the one
// thing resolved server-side is a human title from the template registry's
// description — static per-template copy that names no tenant data. Entity
// pointers pass through opaque; they are never resolved into names, amounts
// or documents (that resolution belongs to the app surface the pointer links
// to, behind its own route gates).
function titleFor(templateKey: string): string {
  const template = TEMPLATES[templateKey];
  if (template) return template.description;
  // Unknown key (e.g. a template retired after the row was written): humanize
  // the key itself rather than failing the whole feed.
  const words = templateKey.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : templateKey;
}

// The one ref this principal may read, or null when the ledger carries no
// recipient identity for its role.
function recipientRefForPrincipal(principal: Principal): string | null {
  if (principal.role === "client_user") {
    return principal.clientPartyId
      ? recipientRefFor(principal.clientPartyId)
      : null;
  }
  if (principal.role === "firm_admin" || principal.role === "firm_staff") {
    return pointerEntityRef("usr", principal.userId);
  }
  return null;
}

export async function listNotificationsFor(
  principal: Principal,
  limit = 50,
): Promise<NotificationItem[]> {
  // Clamp defensively even though the route's query validator already bounds
  // it — the module is the wall, not the parse.
  const capped = Math.min(100, Math.max(1, Math.floor(limit)));
  const ref = recipientRefForPrincipal(principal);
  if (!ref) return [];
  const rows = await getDb()
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.recipientRef, ref))
    .orderBy(desc(messagesTable.createdAt))
    .limit(capped);
  return rows.map((row) => ({
    id: row.id,
    channel: row.channel,
    templateKey: row.templateKey,
    title: titleFor(row.templateKey),
    entityType: row.entityType,
    entityId: row.entityId,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  }));
}
