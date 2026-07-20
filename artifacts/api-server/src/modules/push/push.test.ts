import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  getDb,
  partiesTable,
  usersTable,
  pushDevicesTable,
  messagesTable,
} from "@workspace/db";
import {
  sendPushAlert,
  setPushTransport,
  resetPushTransport,
  setPushReceiptTransport,
  resetPushReceiptTransport,
} from "./push.ts";

// Dead-token pruning (SME-05/08 hygiene): when Expo reports a token as
// DeviceNotRegistered — either immediately in the send ticket or later in the
// push receipt — its push_devices row must be deleted so future fan-outs skip
// it instead of accumulating failed message ledger rows. Live tokens must
// never be touched.

const partyId = randomUUID();
const userId = randomUUID();
const recipientRef = `ref-${partyId.replace(/[^a-z]/gi, "").slice(0, 16)}`;

// Tokens are globally unique; suffix with a UUID so reruns never collide.
const run = randomUUID().slice(0, 8);
const deadTicketToken = `ExponentPushToken[dead-ticket-${run}]`;
const deadReceiptToken = `ExponentPushToken[dead-receipt-${run}]`;
const liveToken = `ExponentPushToken[live-${run}]`;
const allTokens = [deadTicketToken, deadReceiptToken, liveToken];

let fixturesCreated = false;

async function ensureFixtures(): Promise<void> {
  if (fixturesCreated) return;
  await getDb()
    .insert(partiesTable)
    .values({
      id: partyId,
      type: "client_business",
      legalName: "Push Prune Test Party",
    })
    .onConflictDoNothing();
  await getDb()
    .insert(usersTable)
    .values({
      id: userId,
      email: `push-prune-${run}@test.invalid`,
      fullName: "Push Prune Tester",
    })
    .onConflictDoNothing();
  await getDb()
    .insert(pushDevicesTable)
    .values(
      allTokens.map((expoPushToken) => ({
        userId,
        firmId: null,
        clientPartyId: partyId,
        expoPushToken,
        platform: "android",
      })),
    )
    .onConflictDoNothing();
  fixturesCreated = true;
}

after(async () => {
  resetPushTransport();
  resetPushReceiptTransport();
  if (fixturesCreated) {
    await getDb()
      .delete(pushDevicesTable)
      .where(inArray(pushDevicesTable.expoPushToken, allTokens));
    await getDb()
      .delete(messagesTable)
      .where(eq(messagesTable.recipientRef, recipientRef));
    await getDb().delete(usersTable).where(eq(usersTable.id, userId));
    await getDb().delete(partiesTable).where(eq(partiesTable.id, partyId));
  }
});

async function remainingTokens(): Promise<string[]> {
  const rows = await getDb()
    .select({ expoPushToken: pushDevicesTable.expoPushToken })
    .from(pushDevicesTable)
    .where(inArray(pushDevicesTable.expoPushToken, allTokens));
  return rows.map((r) => r.expoPushToken).sort();
}

test("DeviceNotRegistered tokens are pruned from tickets AND receipts; live tokens survive", async () => {
  await ensureFixtures();

  // Ticket order mirrors the notifications array; key behaviour off the `to`
  // token so DB row ordering never matters.
  const receiptIds = new Map<string, string>();
  setPushTransport(async (notifications) => {
    // Pointer-only routing hint: every notification must carry the template
    // key in `data` (and nothing else) so the app can deep-link on tap.
    for (const n of notifications) {
      assert.deepEqual(n.data, { template: "deadline_reminder" });
    }
    return {
      ok: true,
      tickets: notifications.map((n) => {
        if (n.to === deadTicketToken) {
          return {
            status: "error" as const,
            message: "not registered",
            error: "DeviceNotRegistered",
          };
        }
        const id = `ticket-${randomUUID()}`;
        receiptIds.set(id, n.to);
        return { status: "ok" as const, id };
      }),
    };
  });
  setPushReceiptTransport(async (ids) => {
    const receipts: Record<string, { status: string; error?: string }> = {};
    for (const id of ids) {
      const token = receiptIds.get(id);
      receipts[id] =
        token === deadReceiptToken
          ? { status: "error", error: "DeviceNotRegistered" }
          : { status: "ok" };
    }
    return receipts;
  });

  const outcome = await sendPushAlert({
    clientPartyId: partyId,
    firmId: null,
    templateKey: "deadline_reminder",
  });
  assert.equal(outcome.status, "sent");

  assert.deepEqual(
    await remainingTokens(),
    [liveToken],
    "both dead tokens must be deleted; the live token must remain",
  );

  // The ledger row stamps the REAL recipient identity (the client party) the
  // notification inbox scopes by; the lossy ref stays display-only.
  const [ledgerRow] = await getDb()
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.recipientRef, recipientRef));
  assert.equal(ledgerRow.recipientPartyId, partyId);
  assert.equal(ledgerRow.recipientUserId, null);
});

test("after all tokens are pruned, subsequent sends skip without a ledger row", async () => {
  await ensureFixtures();

  // Kill the remaining live token via a ticket-level DeviceNotRegistered.
  setPushTransport(async (notifications) => ({
    ok: false,
    detail: "all dead",
    tickets: notifications.map(() => ({
      status: "error" as const,
      error: "DeviceNotRegistered",
    })),
  }));
  setPushReceiptTransport(async () => ({}));
  await sendPushAlert({
    clientPartyId: partyId,
    firmId: null,
    templateKey: "deadline_reminder",
  });
  assert.deepEqual(await remainingTokens(), [], "no tokens should remain");

  const ledgerBefore = await getDb()
    .select({ id: messagesTable.id })
    .from(messagesTable)
    .where(eq(messagesTable.recipientRef, recipientRef));

  // With the registry empty the fan-out short-circuits: no transport call and
  // no new ledger row — dead tokens stop accumulating failures.
  setPushTransport(async () => {
    throw new Error("transport must not be called when no devices remain");
  });
  const outcome = await sendPushAlert({
    clientPartyId: partyId,
    firmId: null,
    templateKey: "deadline_reminder",
  });
  assert.equal(outcome.status, "skipped");

  const ledgerAfter = await getDb()
    .select({ id: messagesTable.id })
    .from(messagesTable)
    .where(eq(messagesTable.recipientRef, recipientRef));
  assert.equal(
    ledgerAfter.length,
    ledgerBefore.length,
    "a skipped send must not add ledger rows",
  );
});

test("transport failure without tickets prunes nothing", async () => {
  // Re-create a device (previous test emptied the registry).
  await getDb()
    .insert(pushDevicesTable)
    .values({
      userId,
      firmId: null,
      clientPartyId: partyId,
      expoPushToken: liveToken,
      platform: "android",
    })
    .onConflictDoNothing();

  setPushTransport(async () => {
    throw new Error("network down");
  });
  setPushReceiptTransport(async () => ({}));

  const outcome = await sendPushAlert({
    clientPartyId: partyId,
    firmId: null,
    templateKey: "deadline_reminder",
  });
  assert.equal(outcome.status, "failed");
  assert.deepEqual(
    await remainingTokens(),
    [liveToken],
    "a transient transport failure must not delete tokens",
  );
});
