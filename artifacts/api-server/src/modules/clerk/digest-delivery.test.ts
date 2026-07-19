import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, gte } from "drizzle-orm";
import {
  getDb,
  firmsTable,
  usersTable,
  featureFlagsTable,
  messagesTable,
  pushDevicesTable,
  staffNotificationPreferencesTable,
  clerkDigestsTable,
} from "@workspace/db";
import { deliverFirmDigests, digestWeekStart } from "./digest.ts";
import { pointerEntityRef } from "../messaging/recipient-ref.ts";
import { setPushTransport, resetPushTransport } from "../push/push.ts";
import { setFlag } from "../flags/flags.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Weekly-digest delivery to opted-in firm staff. Pinned invariants:
//  - claim-first compare-and-set on delivered_at: a digest is offered exactly
//  once across any number of passes/instances;
//  - OPT-IN semantics: no opted-in staff (or opted-in with no live channel)
//  claims silently — quiet is correct, not a failure — and there is NO party
//  consent gate (the recipient is a firm member, not a client);
//  - a dark messaging_notifications flag claims silently (PL-02);
//  - payloads are pointer-only (SEC-12): opaque user pointer as recipientRef,
//  dig-<letters> as entityId, never the member's email address.

const SALT = makeRunSalt();
const firmDeliver = randomUUID();
const firmOptOut = randomUUID();
const firmDark = randomUUID();
const emailStaff = randomUUID();
const pushStaff = randomUUID();
const optOutStaff = randomUUID();
const noChannelStaff = randomUUID();
const darkStaff = randomUUID();

const MESSAGING_FLAG = "messaging_notifications";
let messagingFlagWasEnabled: boolean | null = null;

// Only rows written by THIS run: pointer refs are 6 letters of a uuid, so a
// long-lived scratch DB could hold colliding rows from earlier runs.
const testStart = new Date(Date.now() - 1_000);

async function digestMessagesFor(userId: string) {
  return getDb()
    .select()
    .from(messagesTable)
    .where(
      and(
        eq(messagesTable.recipientRef, pointerEntityRef("usr", userId)),
        eq(messagesTable.templateKey, "firm_digest_ready"),
        gte(messagesTable.createdAt, testStart),
      ),
    );
}

// The shared DB accumulates undelivered digest rows from every suite that
// ever ran, and one pass is bounded — drain until the pass claims nothing so
// the assertions see this file's fixtures processed.
async function drainDeliveries() {
  while ((await deliverFirmDigests()) > 0) {
    /* keep delivering */
  }
}

async function seedDigest(firmId: string, weeksAgo: number) {
  const weekStart = digestWeekStart(
    new Date(Date.now() - weeksAgo * 7 * 24 * 60 * 60 * 1000),
  );
  const [row] = await getDb()
    .insert(clerkDigestsTable)
    .values({
      firmId,
      weekStart,
      headline: `Seeded digest ${SALT}`,
      bullets: ["Nothing needs your attention."],
      source: "template",
    })
    .returning();
  return row;
}

async function digestById(id: string) {
  const [row] = await getDb()
    .select()
    .from(clerkDigestsTable)
    .where(eq(clerkDigestsTable.id, id))
    .limit(1);
  return row;
}

before(async () => {
  const db = getDb();
  const [existingFlag] = await db
    .select()
    .from(featureFlagsTable)
    .where(eq(featureFlagsTable.key, MESSAGING_FLAG))
    .limit(1);
  messagingFlagWasEnabled = existingFlag ? existingFlag.enabled : null;
  await db
    .insert(featureFlagsTable)
    .values({ key: MESSAGING_FLAG, enabled: true, description: "test" })
    .onConflictDoUpdate({
      target: featureFlagsTable.key,
      set: { enabled: true },
    });

  await db.insert(firmsTable).values([
    { id: firmDeliver, name: `Digest Deliver Firm ${SALT}` },
    { id: firmOptOut, name: `Digest OptOut Firm ${SALT}` },
    { id: firmDark, name: `Digest Dark Firm ${SALT}` },
  ]);
  await db.insert(usersTable).values([
    { id: emailStaff, email: `dd-email-${SALT}@test.example` },
    { id: pushStaff, email: `dd-push-${SALT}@test.example` },
    { id: optOutStaff, email: `dd-optout-${SALT}@test.example` },
    { id: noChannelStaff, email: `dd-nochan-${SALT}@test.example` },
    { id: darkStaff, email: `dd-dark-${SALT}@test.example` },
  ]);
  await db.insert(staffNotificationPreferencesTable).values([
    // Opted in, email channel with an address on the preference row.
    {
      userId: emailStaff,
      firmId: firmDeliver,
      digestEnabled: true,
      emailEnabled: true,
      pushEnabled: false,
      email: `inbox-${SALT}@test.example`,
    },
    // Opted in, push channel; a registered device below makes the send real.
    {
      userId: pushStaff,
      firmId: firmDeliver,
      digestEnabled: true,
      emailEnabled: false,
      pushEnabled: true,
      email: null,
    },
    // digestEnabled=false: opted OUT — must never be addressed.
    {
      userId: optOutStaff,
      firmId: firmOptOut,
      digestEnabled: false,
      emailEnabled: true,
      pushEnabled: true,
      email: `optout-${SALT}@test.example`,
    },
    // Opted in but every channel off — nothing to send through.
    {
      userId: noChannelStaff,
      firmId: firmOptOut,
      digestEnabled: true,
      emailEnabled: false,
      pushEnabled: false,
      email: null,
    },
    // Opted in with a live channel, but the dark-flag test suppresses it.
    {
      userId: darkStaff,
      firmId: firmDark,
      digestEnabled: true,
      emailEnabled: true,
      pushEnabled: false,
      email: `dark-${SALT}@test.example`,
    },
  ]);
  await db.insert(pushDevicesTable).values({
    userId: pushStaff,
    firmId: firmDeliver,
    expoPushToken: `ExponentPushToken[dd-${SALT}]`,
    platform: "ios",
  });
  // Every notification succeeds without touching the network.
  setPushTransport(async (notifications) => ({
    ok: true,
    tickets: notifications.map(() => ({ status: "ok" as const })),
  }));
});

after(async () => {
  resetPushTransport();
  if (messagingFlagWasEnabled === null) {
    await getDb()
      .delete(featureFlagsTable)
      .where(eq(featureFlagsTable.key, MESSAGING_FLAG));
  } else {
    await setFlag(MESSAGING_FLAG, messagingFlagWasEnabled);
  }
});

test("delivery: a digest is offered exactly once across two passes, pointer-only", async () => {
  const row = await seedDigest(firmDeliver, 0);
  await drainDeliveries();

  const claimed = await digestById(row.id);
  assert.ok(claimed.deliveredAt, "the claim marked the row delivered");

  // One email to the email-opted member, one push to the push-opted member —
  // both ledgered under the opaque user pointer.
  const emailMsgs = await digestMessagesFor(emailStaff);
  assert.deepEqual(emailMsgs.map((m) => m.channel), ["email"]);
  const pushMsgs = await digestMessagesFor(pushStaff);
  assert.deepEqual(pushMsgs.map((m) => m.channel), ["push"]);

  // Pointer-only payload (SEC-12): opaque refs, never the email address.
  for (const m of [...emailMsgs, ...pushMsgs]) {
    assert.match(m.recipientRef, /^usr-[a-f]{0,6}$/);
    assert.ok(!m.recipientRef.includes("@"));
    assert.equal(m.entityType, "clerk_digest");
    assert.equal(m.entityId, pointerEntityRef("dig", row.id));
  }

  // Second pass: the delivered_at claim blocks a re-send.
  await drainDeliveries();
  assert.equal((await digestMessagesFor(emailStaff)).length, 1);
  assert.equal((await digestMessagesFor(pushStaff)).length, 1);
});

test("delivery: opted-out staff (and channel-less opt-ins) claim silently", async () => {
  const row = await seedDigest(firmOptOut, 0);
  await drainDeliveries();

  // The claim retires the row — opt-in means quiet is correct — and neither
  // the opted-out member nor the channel-less one is addressed.
  const claimed = await digestById(row.id);
  assert.ok(claimed.deliveredAt);
  assert.equal((await digestMessagesFor(optOutStaff)).length, 0);
  assert.equal((await digestMessagesFor(noChannelStaff)).length, 0);
});

test("delivery: a dark messaging flag claims silently (PL-02)", async () => {
  await setFlag(MESSAGING_FLAG, false);
  try {
    const row = await seedDigest(firmDark, 0);
    await drainDeliveries();

    // Claimed while dark: turning the flag on later must not blast a backlog.
    const claimed = await digestById(row.id);
    assert.ok(claimed.deliveredAt);
    assert.equal((await digestMessagesFor(darkStaff)).length, 0);
  } finally {
    await setFlag(MESSAGING_FLAG, true);
  }

  // Still nothing after the flag returns: the claim already happened.
  await drainDeliveries();
  assert.equal((await digestMessagesFor(darkStaff)).length, 0);
});
