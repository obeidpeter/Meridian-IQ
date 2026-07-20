import { and, desc, eq, isNull, lte, sql } from "drizzle-orm";
import { getDb, messagesTable } from "@workspace/db";
import { isUuid } from "../../lib/uuid";
import type { Principal } from "../auth/rbac";
import { TEMPLATES } from "./messaging";

// Notification inbox: the messages ledger read from the RECIPIENT's side.
// Every alert the platform sends lands one pointer-only row in `messages`
// (SEC-12) addressed by an exact recipient identity column plus an opaque
// display ref minted by recipient-ref.ts. This module resolves the signed-in
// principal to the ONE identity column that names it and returns its rows,
// newest first.
//
// Scoping (SEC-03): `messages` has NO firm key and NO RLS policy — it is a
// platform-wide pointer ledger — so the recipient-identity equality below IS
// the isolation wall. It is deliberately the recipient_user_id /
// recipient_party_id uuid columns, NOT recipient_ref: the ref is a lossy
// letters-only derivation (staff refs carry ~15.5 bits), so ref collisions
// are certain at scale and the ref is kept for display and provider-side
// correlation only. Firm-keyed RLS could not help here anyway (the table has
// no firm column), and it would not be a sibling wall even if it could: two
// client_users of the same firm share the firm's RLS scope, so the per-party
// identity equality is what keeps sibling clients out of each other's feeds.
//
// Rows written BEFORE the identity columns existed carry null identities and
// silently drop out of every feed. Accepted deliberately: the ledger is
// pointer-only history — losing a stale "something happened, open the app"
// row is strictly better than serving it to a colliding ref-holder.
//
// Per-role resolution:
//  - client_user  → recipient_party_id = its own clientPartyId, the identity
//    every party-scoped alert rail (fan-out.ts, reminders, B2C, statements)
//    stamps on its sends.
//  - firm_admin / firm_staff → recipient_user_id = their own userId, the
//    identity the staff-preference rails (digest delivery, push) stamp.
//    Staff deliberately do NOT also see their firm's party rows: a party
//    alert belongs to the CLIENT it was addressed to — surfacing it in a
//    staff feed would leak per-client alert traffic to every teammate and
//    turn the feed into a firm-wide monitor, which the operator message log
//    (GET /messages) already is, behind its own operator gate.
//  - operator / auditor / bank_user / buyer_user → empty feed: no send rail
//    stamps a recipient identity for these roles, so the ledger simply has
//    no rows for them to claim.

export interface NotificationItem {
  id: string;
  channel: string;
  templateKey: string;
  title: string;
  entityType: string | null;
  entityId: string | null;
  status: string;
  read: boolean;
  createdAt: string;
}

export interface NotificationFeed {
  items: NotificationItem[];
  unreadCount: number;
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

// The one identity column + value this principal may read, or null when the
// ledger carries no recipient identity for its role. The isUuid guard covers
// the dev-header shim (a non-uuid userId like "dev-user" owns no rows and
// must not error the uuid-column comparison).
function recipientIdentityFor(
  principal: Principal,
):
  | { column: typeof messagesTable.recipientPartyId | typeof messagesTable.recipientUserId; value: string }
  | null {
  if (principal.role === "client_user") {
    return principal.clientPartyId && isUuid(principal.clientPartyId)
      ? { column: messagesTable.recipientPartyId, value: principal.clientPartyId }
      : null;
  }
  if (principal.role === "firm_admin" || principal.role === "firm_staff") {
    return isUuid(principal.userId)
      ? { column: messagesTable.recipientUserId, value: principal.userId }
      : null;
  }
  return null;
}

export async function notificationFeedFor(
  principal: Principal,
  limit = 50,
): Promise<NotificationFeed> {
  // Clamp defensively even though the route's query validator already bounds
  // it — the module is the wall, not the parse.
  const capped = Math.min(100, Math.max(1, Math.floor(limit)));
  const identity = recipientIdentityFor(principal);
  if (!identity) return { items: [], unreadCount: 0 };
  const scope = eq(identity.column, identity.value);
  const rows = await getDb()
    .select()
    .from(messagesTable)
    .where(scope)
    .orderBy(desc(messagesTable.createdAt))
    .limit(capped);
  // Unread count under the SAME identity predicate as the row scan — the
  // count must never see (or leak the existence of) rows the feed itself
  // would not serve. Counted over the whole feed, not just the returned
  // page, so the badge stays honest past the limit.
  const [{ unread }] = await getDb()
    .select({ unread: sql<number>`count(*)::int` })
    .from(messagesTable)
    .where(and(scope, isNull(messagesTable.readAt)));
  return {
    items: rows.map((row) => ({
      id: row.id,
      channel: row.channel,
      templateKey: row.templateKey,
      title: titleFor(row.templateKey),
      entityType: row.entityType,
      entityId: row.entityId,
      status: row.status,
      read: row.readAt != null,
      createdAt: row.createdAt.toISOString(),
    })),
    unreadCount: unread,
  };
}

// Mark the caller's own notifications at-or-before a timestamp as read and
// return the refreshed feed. The UPDATE runs under the SAME recipient-identity
// predicate that scopes reads (SEC-03: identity columns are the wall — a
// caller can never flip read-state on a sibling's or colliding-ref rows).
// `created_at <= upToCreatedAt` (inclusive) lets the client pass its newest
// visible item's createdAt and mark exactly what it has seen — rows sent
// AFTER that instant stay unread. Already-read rows are skipped so read_at
// keeps the FIRST read time (idempotent re-marks touch nothing).
export async function markNotificationsRead(
  principal: Principal,
  upToCreatedAt: Date,
  limit = 50,
): Promise<NotificationFeed> {
  const identity = recipientIdentityFor(principal);
  if (identity) {
    // DB-clock now() so read_at can never precede a created_at stamped by
    // the same database. The ORM update also bumps updated_at ($onUpdate) —
    // harmless here: nothing reads messages.updated_at as a clock, and the
    // retention sweep deletes by created_at.
    await getDb()
      .update(messagesTable)
      .set({ readAt: sql`now()` })
      .where(
        and(
          eq(identity.column, identity.value),
          lte(messagesTable.createdAt, upToCreatedAt),
          isNull(messagesTable.readAt),
        ),
      );
  }
  return notificationFeedFor(principal, limit);
}
