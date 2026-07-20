import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getDb, messagesTable } from "@workspace/db";
import { listNotificationsFor } from "./inbox.ts";
import { TEMPLATES } from "./messaging.ts";
import { pointerEntityRef, recipientRefFor } from "./recipient-ref.ts";
import type { Principal } from "../auth/rbac.ts";
import messagingRouter from "../../routes/messaging.ts";
import {
  appFor,
  listen,
  closeAllServers,
} from "../../test-helpers/route-harness.ts";

// Notification inbox scoping (SEC-03). The messages ledger has NO firm key
// and NO RLS policy, so the recipient_ref equality inside listNotificationsFor
// IS the isolation wall — these tests pin it from every side:
//  - a client_user sees exactly its own party's `ref-…` rows;
//  - a SIBLING client of the same firm sees none of them;
//  - firm staff see exactly their own `usr-…` rows — NOT the firm's party
//    alerts (those belong to the client they were addressed to);
//  - roles with no recipient identity in the ledger (operator here) get an
//    empty feed;
//  - titles resolve from the template registry (unknown keys humanize, never
//    throw), rows stay pointer-only, newest-first, limit clamped to 1..100.

// Ref-target ids are RANDOM LETTERS so each run's refs are unique on a
// long-lived scratch DB (recipientRefFor keeps the first 16 letters;
// pointerEntityRef the first 6 — uuid hex letters alone would collide).
const letters = (n: number): string =>
  Array.from({ length: n }, () =>
    String.fromCharCode(97 + Math.floor(Math.random() * 26)),
  ).join("");

const firmId = randomUUID();
const partyA = letters(20);
const partyB = letters(20);
const staffUserId = letters(20);

const refA = recipientRefFor(partyA);
const refB = recipientRefFor(partyB);
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

before(async () => {
  await getDb()
    .insert(messagesTable)
    .values([
      // Client A's feed: two known templates + one whose template no longer
      // exists in the registry (retired after the send), oldest first.
      {
        channel: "email",
        recipientRef: refA,
        templateKey: "deadline_reminder",
        entityType: "invoice",
        entityId: "inv-abc",
        status: "sent",
        createdAt: at(30),
      },
      {
        channel: "whatsapp",
        recipientRef: refA,
        templateKey: "invoice_stamped",
        entityType: "invoice",
        entityId: "inv-def",
        status: "delivered",
        createdAt: at(20),
      },
      {
        channel: "push",
        recipientRef: refA,
        templateKey: "some_retired_template",
        status: "sent",
        createdAt: at(10),
      },
      // Sibling client B, same firm: must never surface in A's feed.
      {
        channel: "sms",
        recipientRef: refB,
        templateKey: "deadline_reminder",
        status: "sent",
        createdAt: at(15),
      },
      // Staff member's own row (the digest-delivery rail's shape).
      {
        channel: "push",
        recipientRef: refStaff,
        templateKey: "firm_digest_ready",
        entityType: "clerk_digest",
        entityId: "dig-abc",
        status: "sent",
        createdAt: at(5),
      },
    ]);
});

after(async () => {
  await closeAllServers();
});

test("a client_user sees exactly its own party's rows, newest first", async () => {
  const items = await listNotificationsFor(clientA);
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
});

test("titles resolve from the template registry; unknown keys humanize", async () => {
  const items = await listNotificationsFor(clientA);
  const stamped = items.find((i) => i.templateKey === "invoice_stamped");
  assert.equal(stamped?.title, TEMPLATES.invoice_stamped.description);
  const retired = items.find((i) => i.templateKey === "some_retired_template");
  assert.equal(retired?.title, "Some retired template");
});

test("a sibling client of the same firm sees none of them (SEC-03)", async () => {
  const items = await listNotificationsFor(siblingClientB);
  assert.equal(items.length, 1, "only its own row");
  assert.equal(items[0].channel, "sms");
  assert.ok(items.every((i) => i.templateKey !== "invoice_stamped"));
});

test("firm staff see their own usr- rows only — never the firm's party alerts", async () => {
  const items = await listNotificationsFor(staff);
  assert.equal(items.length, 1);
  assert.equal(items[0].templateKey, "firm_digest_ready");
  assert.equal(items[0].title, TEMPLATES.firm_digest_ready.description);
});

test("roles without a recipient identity in the ledger get an empty feed", async () => {
  assert.deepEqual(await listNotificationsFor(operator), []);
  // A client_user missing its party scope resolves to no ref — empty, never
  // someone else's rows.
  assert.deepEqual(
    await listNotificationsFor({ ...clientA, clientPartyId: null }),
    [],
  );
});

test("limit is clamped to 1..100", async () => {
  const one = await listNotificationsFor(clientA, 0);
  assert.equal(one.length, 1, "0 clamps up to 1");
  assert.equal(one[0].templateKey, "some_retired_template", "and keeps newest");
  const all = await listNotificationsFor(clientA, 100_000);
  assert.equal(all.length, 3, "an oversized limit still answers");
});

test("GET /notifications serves the feed to any authenticated principal; bad limit 400s", async () => {
  const base = await listen(appFor(clientA, messagingRouter));
  const res = await fetch(`${base}/notifications?limit=2`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    items: Array<{ templateKey: string; title: string; createdAt: string }>;
  };
  assert.equal(body.items.length, 2);
  assert.equal(body.items[0].templateKey, "some_retired_template");
  assert.equal(typeof body.items[0].createdAt, "string");

  // The contract bounds limit to 1..100; out-of-range is a validation 400.
  const bad = await fetch(`${base}/notifications?limit=0`);
  assert.equal(bad.status, 400);

  // The operator's empty feed is a 200 with no items, not an error.
  const opBase = await listen(appFor(operator, messagingRouter));
  const opRes = await fetch(`${opBase}/notifications`);
  assert.equal(opRes.status, 200);
  assert.deepEqual(await opRes.json(), { items: [] });
});
