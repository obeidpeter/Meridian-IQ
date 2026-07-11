import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  getDb,
  partiesTable,
  usersTable,
  pushDevicesTable,
  pushTicketsTable,
  messagesTable,
} from "@workspace/db";
import {
  sendPushAlert,
  sweepPushReceipts,
  setPushTransport,
  resetPushTransport,
  setPushReceiptTransport,
  resetPushReceiptTransport,
} from "./push.ts";

// Late-receipt straggler pruning (SME-05/08 hygiene): Expo materialises push
// receipts asynchronously (often ~15 minutes after the send), so a token whose
// death is only visible in a late receipt survives the immediate post-send
// check. Successful send tickets are persisted to push_tickets; the periodic
// sweep re-checks their receipts, prunes DeviceNotRegistered tokens, and
// cleans up processed rows so the table stays bounded.

const partyId = randomUUID();
const userId = randomUUID();
const recipientRef = `ref-${partyId.replace(/[^a-z]/gi, "").slice(0, 16)}`;

const run = randomUUID().slice(0, 8);
const lateDeadToken = `ExponentPushToken[sweep-dead-${run}]`;
const lateLiveToken = `ExponentPushToken[sweep-live-${run}]`;
const allTokens = [lateDeadToken, lateLiveToken];

let fixturesCreated = false;

async function ensureFixtures(): Promise<void> {
  if (fixturesCreated) return;
  await getDb()
    .insert(partiesTable)
    .values({
      id: partyId,
      type: "client_business",
      legalName: "Push Sweep Test Party",
    })
    .onConflictDoNothing();
  await getDb()
    .insert(usersTable)
    .values({
      id: userId,
      email: `push-sweep-${run}@test.invalid`,
      fullName: "Push Sweep Tester",
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
      .delete(pushTicketsTable)
      .where(inArray(pushTicketsTable.expoPushToken, allTokens));
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

async function pendingTickets(): Promise<
  { ticketId: string; expoPushToken: string }[]
> {
  return getDb()
    .select({
      ticketId: pushTicketsTable.ticketId,
      expoPushToken: pushTicketsTable.expoPushToken,
    })
    .from(pushTicketsTable)
    .where(inArray(pushTicketsTable.expoPushToken, allTokens));
}

const ticketIdByToken = new Map<string, string>();

test("tickets whose receipts are not yet available are persisted for the sweep", async () => {
  await ensureFixtures();

  setPushTransport(async (notifications) => ({
    ok: true,
    tickets: notifications.map((n) => {
      const id = `sweep-ticket-${randomUUID()}`;
      ticketIdByToken.set(n.to, id);
      return { status: "ok" as const, id };
    }),
  }));
  // Receipts not materialised yet: the immediate check resolves nothing.
  setPushReceiptTransport(async () => ({}));

  const outcome = await sendPushAlert({
    clientPartyId: partyId,
    firmId: null,
    templateKey: "deadline_reminder",
  });
  assert.equal(outcome.status, "sent");

  const pending = await pendingTickets();
  assert.equal(pending.length, 2, "both ok tickets must be persisted");
  for (const [token, id] of ticketIdByToken) {
    assert.ok(
      pending.some((p) => p.ticketId === id && p.expoPushToken === token),
      `ticket ${id} for ${token} must be pending`,
    );
  }
  assert.deepEqual(
    await remainingTokens(),
    allTokens.slice().sort(),
    "no device may be pruned while receipts are unknown",
  );
});

test("sweep ignores tickets younger than the receipt delay", async () => {
  await ensureFixtures();
  setPushReceiptTransport(async () => {
    throw new Error("receipt transport must not be called for young tickets");
  });
  // Default cutoff is ~15 minutes; the rows just created are seconds old.
  const pruned = await sweepPushReceipts();
  assert.equal(pruned, 0);
  assert.equal((await pendingTickets()).length, 2, "tickets must remain");
});

test("sweep prunes late DeviceNotRegistered receipts and cleans up tickets", async () => {
  await ensureFixtures();

  const deadTicketId = ticketIdByToken.get(lateDeadToken)!;
  const liveTicketId = ticketIdByToken.get(lateLiveToken)!;

  // The dead token's receipt has materialised; the live token's has not yet.
  setPushReceiptTransport(async (ids) => {
    const receipts: Record<string, { status: string; error?: string }> = {};
    for (const id of ids) {
      if (id === deadTicketId) {
        receipts[id] = { status: "error", error: "DeviceNotRegistered" };
      }
    }
    return receipts;
  });

  // olderThanMs=0 makes the just-created tickets due immediately.
  const pruned = await sweepPushReceipts(0);
  assert.equal(pruned, 1, "exactly the dead device must be pruned");
  assert.deepEqual(
    await remainingTokens(),
    [lateLiveToken],
    "the live token must survive",
  );

  const pending = await pendingTickets();
  assert.deepEqual(
    pending.map((p) => p.ticketId),
    [liveTicketId],
    "the resolved ticket is deleted; the unresolved one stays pending",
  );

  // Second pass: the live receipt materialises as ok — the device stays, the
  // ticket is cleaned up, and the table is empty (no unbounded growth).
  setPushReceiptTransport(async (ids) => {
    const receipts: Record<string, { status: string; error?: string }> = {};
    for (const id of ids) receipts[id] = { status: "ok" };
    return receipts;
  });
  const prunedSecond = await sweepPushReceipts(0);
  assert.equal(prunedSecond, 0);
  assert.deepEqual(await remainingTokens(), [lateLiveToken]);
  assert.equal(
    (await pendingTickets()).length,
    0,
    "all processed tickets must be cleaned up",
  );
});

test("expired tickets are dropped even when no receipt ever materialises", async () => {
  await ensureFixtures();

  const staleTicketId = `sweep-ticket-stale-${randomUUID()}`;
  await getDb().insert(pushTicketsTable).values({
    ticketId: staleTicketId,
    expoPushToken: lateLiveToken,
    // Older than the 24h expiry: Expo no longer holds this receipt.
    createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
  });

  // Expo returns nothing for expired ids — and must not even be asked.
  setPushReceiptTransport(async (ids) => {
    assert.ok(
      !ids.includes(staleTicketId),
      "expired tickets must not be re-checked",
    );
    return {};
  });

  await sweepPushReceipts(0);
  const pending = await pendingTickets();
  assert.ok(
    !pending.some((p) => p.ticketId === staleTicketId),
    "the expired ticket must be deleted",
  );
  assert.deepEqual(
    await remainingTokens(),
    [lateLiveToken],
    "expiry cleanup must never prune devices",
  );
});
