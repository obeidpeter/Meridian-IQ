import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { getDb, messagesTable } from "@workspace/db";
import { markNotificationsRead, notificationFeedFor } from "./inbox.ts";
import { TEMPLATES } from "./messaging.ts";
import { pointerEntityRef, recipientRefFor } from "./recipient-ref.ts";
import type { Principal } from "../auth/rbac.ts";
import messagingRouter from "../../routes/messaging.ts";
import {
  appFor,
  listen,
  closeAllServers,
  JSON_HEADERS,
} from "../../test-helpers/route-harness.ts";

// Notification inbox scoping (SEC-03). The messages ledger has NO firm key
// and NO RLS policy, so the recipient IDENTITY equality inside
// notificationFeedFor IS the isolation wall — and it is the
// recipient_party_id / recipient_user_id uuid columns, NOT the lossy
// letters-only recipient_ref (staff refs carry ~15.5 bits; ref collisions are
// certain at scale). These tests pin it from every side:
//  - a client_user sees exactly the rows stamped with its own party id;
//  - a SIBLING client of the same firm sees none of them;
//  - a row whose lossy REF collides but whose identity differs never leaks;
//  - rows predating the identity columns (null identity) drop from feeds;
//  - firm staff see exactly their own user-identity rows — NOT the firm's
//    party alerts (those belong to the client they were addressed to);
//  - roles with no recipient identity in the ledger (operator here) get an
//    empty feed;
//  - titles resolve from the template registry (unknown keys humanize, never
//    throw), rows stay pointer-only, newest-first, limit clamped to 1..100.
//
// Read-state rides the same wall: unreadCount is computed under the SAME
// identity predicate as the row scan, and markNotificationsRead UPDATEs under
// it too — marking MY feed can never flip read-state on a sibling's row, a
// colliding-ref row, or a legacy null-identity row. The boundary is
// inclusive: created_at <= upToCreatedAt marks, later rows stay unread.

const firmId = randomUUID();
const partyA = randomUUID();
const partyB = randomUUID();
const collidingParty = randomUUID();
const staffUserId = randomUUID();
const collidingStaffUser = randomUUID();

const refA = recipientRefFor(partyA);
const refStaff = pointerEntityRef("usr", staffUserId);

const clientA: Principal = {
  userId: randomUUID(),
  role: "client_user",
  firmId,
  clientPartyId: partyA,
  buyerPartyId: null,
};
const siblingClientB: Principal = {
  userId: randomUUID(),
  role: "client_user",
  firmId,
  clientPartyId: partyB,
  buyerPartyId: null,
};
const staff: Principal = {
  userId: staffUserId,
  role: "firm_staff",
  firmId,
  clientPartyId: null,
  buyerPartyId: null,
};
const operator: Principal = {
  userId: randomUUID(),
  role: "operator",
  firmId: null,
  clientPartyId: null,
  buyerPartyId: null,
};

const at = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1_000);

// Client A's three feed rows, oldest first; tMiddle is the mark-read
// boundary probe (inclusive: tOldest and tMiddle mark, tNewest stays).
const tOldest = at(30);
const tMiddle = at(20);
const tNewest = at(10);

before(async () => {
  await getDb()
    .insert(messagesTable)
    .values([
      // Client A's feed: two known templates + one whose template no longer
      // exists in the registry (retired after the send), oldest first.
      {
        channel: "email",
        recipientRef: refA,
        recipientPartyId: partyA,
        templateKey: "deadline_reminder",
        entityType: "invoice",
        entityId: "inv-abc",
        status: "sent",
        createdAt: tOldest,
      },
      {
        channel: "whatsapp",
        recipientRef: refA,
        recipientPartyId: partyA,
        templateKey: "invoice_stamped",
        entityType: "invoice",
        entityId: "inv-def",
        status: "delivered",
        createdAt: tMiddle,
      },
      {
        channel: "push",
        recipientRef: refA,
        recipientPartyId: partyA,
        templateKey: "some_retired_template",
        status: "sent",
        createdAt: tNewest,
      },
      // Sibling client B, same firm: must never surface in A's feed.
      {
        channel: "sms",
        recipientRef: recipientRefFor(partyB),
        recipientPartyId: partyB,
        templateKey: "deadline_reminder",
        status: "sent",
        createdAt: at(15),
      },
      // REF COLLISION probe: a row whose lossy recipientRef equals client
      // A's but whose real identity is a DIFFERENT party. The old ref-equality
      // wall would have served this row to A; the identity wall must not.
      {
        channel: "email",
        recipientRef: refA,
        recipientPartyId: collidingParty,
        templateKey: "b2c_window_alert",
        status: "sent",
        createdAt: at(8),
      },
      // Legacy row predating the identity columns (null identity): drops out
      // of every feed — pointer-only history, accepted.
      {
        channel: "email",
        recipientRef: refA,
        templateKey: "deadline_reminder",
        status: "sent",
        createdAt: at(6),
      },
      // Staff member's own row (the digest-delivery rail's shape).
      {
        channel: "push",
        recipientRef: refStaff,
        recipientUserId: staffUserId,
        templateKey: "firm_digest_ready",
        entityType: "clerk_digest",
        entityId: "dig-abc",
        status: "sent",
        createdAt: at(5),
      },
      // Staff-ref collision probe: same lossy usr- ref shape possible for a
      // different user; identity differs, must never surface for staffUserId.
      {
        channel: "email",
        recipientRef: refStaff,
        recipientUserId: collidingStaffUser,
        templateKey: "firm_digest_ready",
        status: "sent",
        createdAt: at(4),
      },
    ]);
});

after(async () => {
  await closeAllServers();
});

test("a client_user sees exactly its own party's rows, newest first", async () => {
  const { items, unreadCount } = await notificationFeedFor(clientA);
  assert.equal(items.length, 3);
  assert.deepEqual(
    items.map((i) => i.templateKey),
    ["some_retired_template", "invoice_stamped", "deadline_reminder"],
    "newest first",
  );
  // Rows stay pointer-only: opaque entity pointers pass through unresolved.
  assert.equal(items[1].entityType, "invoice");
  assert.equal(items[1].entityId, "inv-def");
  assert.equal(items[1].status, "delivered");
  // createdAt is serialized for the wire (the contract says string).
  assert.equal(typeof items[0].createdAt, "string");
  assert.ok(!Number.isNaN(Date.parse(items[0].createdAt)));
  // Nothing marked yet: every row unread, and the count says so.
  assert.ok(items.every((i) => i.read === false));
  assert.equal(unreadCount, 3);
});

test("a colliding recipientRef never leaks: identity, not ref, is the wall", async () => {
  const { items } = await notificationFeedFor(clientA);
  assert.ok(
    items.every((i) => i.templateKey !== "b2c_window_alert"),
    "a row sharing A's lossy ref but stamped with another party's identity must not surface",
  );
});

test("rows predating the identity columns silently drop from feeds", async () => {
  const { items } = await notificationFeedFor(clientA);
  // The legacy null-identity row was the second-newest of A's ref rows;
  // exactly the three identity-stamped rows answer.
  assert.equal(items.length, 3);
});

test("titles resolve from the template registry; unknown keys humanize", async () => {
  const { items } = await notificationFeedFor(clientA);
  const stamped = items.find((i) => i.templateKey === "invoice_stamped");
  assert.equal(stamped?.title, TEMPLATES.invoice_stamped.description);
  const retired = items.find((i) => i.templateKey === "some_retired_template");
  assert.equal(retired?.title, "Some retired template");
});

test("a sibling client of the same firm sees none of them (SEC-03)", async () => {
  const { items, unreadCount } = await notificationFeedFor(siblingClientB);
  assert.equal(items.length, 1, "only its own row");
  assert.equal(items[0].channel, "sms");
  assert.ok(items.every((i) => i.templateKey !== "invoice_stamped"));
  assert.equal(unreadCount, 1, "the count is scoped by the same predicate");
});

test("firm staff see their own user-identity rows only — never the firm's party alerts", async () => {
  const { items } = await notificationFeedFor(staff);
  assert.equal(items.length, 1);
  assert.equal(items[0].templateKey, "firm_digest_ready");
  assert.equal(items[0].channel, "push", "the colliding-ref email row stays out");
  assert.equal(items[0].title, TEMPLATES.firm_digest_ready.description);
});

test("roles without a recipient identity in the ledger get an empty feed", async () => {
  assert.deepEqual(await notificationFeedFor(operator), {
    items: [],
    unreadCount: 0,
  });
  // A client_user missing its party scope resolves to no identity — empty,
  // never someone else's rows.
  assert.deepEqual(await notificationFeedFor({ ...clientA, clientPartyId: null }), {
    items: [],
    unreadCount: 0,
  });
  // The dev-header shim's non-uuid userId owns no rows and must not error
  // the uuid-column comparison.
  assert.deepEqual(await notificationFeedFor({ ...staff, userId: "dev-user" }), {
    items: [],
    unreadCount: 0,
  });
});

test("limit is clamped to 1..100 (unreadCount stays whole-feed, not page)", async () => {
  const one = await notificationFeedFor(clientA, 0);
  assert.equal(one.items.length, 1, "0 clamps up to 1");
  assert.equal(one.items[0].templateKey, "some_retired_template", "and keeps newest");
  assert.equal(one.unreadCount, 3, "the badge counts past the page limit");
  const all = await notificationFeedFor(clientA, 100_000);
  assert.equal(all.items.length, 3, "an oversized limit still answers");
});

test("mark-read boundary is inclusive: at the timestamp marks, after stays unread", async () => {
  const feed = await markNotificationsRead(clientA, tMiddle);
  // tOldest (< boundary) and tMiddle (== boundary) flip; tNewest stays.
  assert.equal(feed.unreadCount, 1);
  const byKey = new Map(feed.items.map((i) => [i.templateKey, i.read]));
  assert.equal(byKey.get("deadline_reminder"), true);
  assert.equal(byKey.get("invoice_stamped"), true, "created_at == boundary marks");
  assert.equal(byKey.get("some_retired_template"), false, "later rows stay unread");
});

test("re-marking is idempotent: already-read rows keep their first read_at", async () => {
  const [before_] = await getDb()
    .select({ readAt: messagesTable.readAt })
    .from(messagesTable)
    .where(eq(messagesTable.recipientPartyId, partyA))
    .orderBy(messagesTable.createdAt)
    .limit(1);
  assert.ok(before_.readAt, "oldest row is read after the previous test");
  const feed = await markNotificationsRead(clientA, tMiddle);
  assert.equal(feed.unreadCount, 1, "nothing new marked");
  const [after_] = await getDb()
    .select({ readAt: messagesTable.readAt })
    .from(messagesTable)
    .where(eq(messagesTable.recipientPartyId, partyA))
    .orderBy(messagesTable.createdAt)
    .limit(1);
  assert.equal(
    after_.readAt?.toISOString(),
    before_.readAt.toISOString(),
    "read_at is the FIRST read time — re-marks skip read rows",
  );
});

test("marking mine never touches a sibling's, a colliding ref's, or a legacy row (SEC-03)", async () => {
  // The previous tests marked client A generously (up to tMiddle); B's row,
  // the colliding-ref row and the legacy null-identity row all fall in that
  // range by created_at — only the identity predicate keeps them unread.
  const [siblingRow] = await getDb()
    .select({ readAt: messagesTable.readAt })
    .from(messagesTable)
    .where(eq(messagesTable.recipientPartyId, partyB));
  assert.equal(siblingRow.readAt, null, "sibling stays unread");
  const [collidingRow] = await getDb()
    .select({ readAt: messagesTable.readAt })
    .from(messagesTable)
    .where(eq(messagesTable.recipientPartyId, collidingParty));
  assert.equal(collidingRow.readAt, null, "colliding lossy ref stays unread");
  const [legacyRow] = await getDb()
    .select({ readAt: messagesTable.readAt })
    .from(messagesTable)
    .where(
      and(
        eq(messagesTable.recipientRef, refA),
        isNull(messagesTable.recipientPartyId),
        isNull(messagesTable.recipientUserId),
      ),
    );
  assert.equal(legacyRow.readAt, null, "legacy null-identity row stays untouched");
  const sibling = await notificationFeedFor(siblingClientB);
  assert.equal(sibling.unreadCount, 1);

  // And the reverse: B marking its whole feed leaves A's remaining unread
  // row (and the staff member's) untouched.
  const bFeed = await markNotificationsRead(siblingClientB, new Date());
  assert.equal(bFeed.unreadCount, 0);
  assert.equal((await notificationFeedFor(clientA)).unreadCount, 1);
  assert.equal((await notificationFeedFor(staff)).unreadCount, 1);
});

test("staff marking marks their own user-identity row only, never the colliding user's", async () => {
  const feed = await markNotificationsRead(staff, new Date());
  assert.equal(feed.unreadCount, 0);
  assert.equal(feed.items[0].read, true);
  const [collidingRow] = await getDb()
    .select({ readAt: messagesTable.readAt })
    .from(messagesTable)
    .where(eq(messagesTable.recipientUserId, collidingStaffUser));
  assert.equal(collidingRow.readAt, null);
});

test("roles without a recipient identity mark nothing and get the empty feed", async () => {
  assert.deepEqual(await markNotificationsRead(operator, new Date()), {
    items: [],
    unreadCount: 0,
  });
});

test("GET /notifications serves the feed to any authenticated principal; bad limit 400s", async () => {
  const base = await listen(appFor(clientA, messagingRouter));
  const res = await fetch(`${base}/notifications?limit=2`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    items: Array<{ templateKey: string; title: string; read: boolean; createdAt: string }>;
    unreadCount: number;
  };
  assert.equal(body.items.length, 2);
  assert.equal(body.items[0].templateKey, "some_retired_template");
  assert.equal(typeof body.items[0].createdAt, "string");
  assert.equal(body.items[0].read, false, "the boundary tests left the newest unread");
  assert.equal(body.unreadCount, 1);

  // The contract bounds limit to 1..100; out-of-range is a validation 400.
  const bad = await fetch(`${base}/notifications?limit=0`);
  assert.equal(bad.status, 400);

  // The operator's empty feed is a 200 with no items, not an error.
  const opBase = await listen(appFor(operator, messagingRouter));
  const opRes = await fetch(`${opBase}/notifications`);
  assert.equal(opRes.status, 200);
  assert.deepEqual(await opRes.json(), { items: [], unreadCount: 0 });
});

test("POST /notifications/mark-read marks the caller's own feed and returns it; bad body 400s", async () => {
  const base = await listen(appFor(clientA, messagingRouter));
  const res = await fetch(`${base}/notifications/mark-read`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ upToCreatedAt: new Date().toISOString() }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    items: Array<{ read: boolean }>;
    unreadCount: number;
  };
  assert.equal(body.unreadCount, 0, "the remaining unread row is now read");
  assert.ok(body.items.every((i) => i.read === true));

  // A missing/garbage timestamp is a validation 400, and marks nothing.
  const bad = await fetch(`${base}/notifications/mark-read`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ upToCreatedAt: "not-a-date" }),
  });
  assert.equal(bad.status, 400);
});
