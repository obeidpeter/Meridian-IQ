import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, messagesTable } from "@workspace/db";
import { sweepMessagesRetention } from "./retention.ts";

// Messages-ledger retention. The sweep deletes pointer-only rows past
// MESSAGES_RETENTION_DAYS (default 180) in bounded oldest-first batches of
// 1000 per pass. These tests pin: old rows go, recent rows stay, the batch
// bound holds (a 1005-row backlog takes two passes), and a nonsense or
// non-positive env value DISABLES the sweep rather than deleting eagerly.
//
// Rows are tagged with per-test random party ids so assertions only ever
// count THIS file's rows — the ledger is shared with other test files' (all
// recent, so the sweep never touches them). Deleted-count assertions drain
// the whole backlog first, so stray old rows from prior runs cannot skew the
// exact bounded-batch numbers.

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1_000);

const row = (partyId: string, createdAt: Date) => ({
  channel: "email" as const,
  recipientRef: "acme",
  recipientPartyId: partyId,
  templateKey: "deadline_reminder",
  status: "sent" as const,
  createdAt,
});

async function countFor(partyId: string): Promise<number> {
  const rows = await getDb()
    .select({ id: messagesTable.id })
    .from(messagesTable)
    .where(eq(messagesTable.recipientPartyId, partyId));
  return rows.length;
}

// Run passes until the backlog is drained (each pass is capped at 1000).
async function drain(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if ((await sweepMessagesRetention()) === 0) return;
  }
  assert.fail("retention backlog did not drain in 50 passes");
}

test("deletes rows older than the window and spares recent ones", async () => {
  const party = randomUUID();
  await getDb()
    .insert(messagesTable)
    .values([
      row(party, daysAgo(200)),
      row(party, daysAgo(181)),
      // Just inside the default 180-day window: must survive.
      row(party, daysAgo(179)),
      row(party, daysAgo(1)),
      row(party, new Date()),
    ]);
  await drain();
  assert.equal(await countFor(party), 3, "the two expired rows are gone");
  const survivors = await getDb()
    .select({ createdAt: messagesTable.createdAt })
    .from(messagesTable)
    .where(eq(messagesTable.recipientPartyId, party));
  assert.ok(
    survivors.every((s) => s.createdAt > daysAgo(180)),
    "every survivor is inside the window",
  );
});

test("deletes are bounded to 1000 per pass, oldest first", async () => {
  // The previous test drained every expired row in the ledger, so the exact
  // per-pass counts below are this backlog's alone.
  const party = randomUUID();
  const backlog = Array.from({ length: 1005 }, (_, i) =>
    row(party, daysAgo(200 + (i % 20))),
  );
  // Chunked inserts to stay well under the driver's parameter cap.
  for (let i = 0; i < backlog.length; i += 500) {
    await getDb().insert(messagesTable).values(backlog.slice(i, i + 500));
  }
  const recentParty = randomUUID();
  await getDb().insert(messagesTable).values([row(recentParty, new Date())]);

  assert.equal(await sweepMessagesRetention(), 1000, "first pass caps at 1000");
  assert.equal(await countFor(party), 5, "the remainder waits for the next pass");
  assert.equal(await sweepMessagesRetention(), 5, "second pass finishes the backlog");
  assert.equal(await sweepMessagesRetention(), 0, "then nothing left to delete");
  assert.equal(await countFor(party), 0);
  assert.equal(await countFor(recentParty), 1, "recent rows ride out every pass");
});

test("a non-positive or malformed retention env disables the sweep", async () => {
  const party = randomUUID();
  await getDb().insert(messagesTable).values([row(party, daysAgo(400))]);
  const original = process.env.MESSAGES_RETENTION_DAYS;
  try {
    process.env.MESSAGES_RETENTION_DAYS = "0";
    assert.equal(await sweepMessagesRetention(), 0);
    process.env.MESSAGES_RETENTION_DAYS = "-7";
    assert.equal(await sweepMessagesRetention(), 0);
    process.env.MESSAGES_RETENTION_DAYS = "garbage";
    assert.equal(await sweepMessagesRetention(), 0);
    assert.equal(await countFor(party), 1, "a disabled sweep deletes nothing");
  } finally {
    if (original === undefined) delete process.env.MESSAGES_RETENTION_DAYS;
    else process.env.MESSAGES_RETENTION_DAYS = original;
  }
  // Back on the 180-day default the row is expired and goes.
  await drain();
  assert.equal(await countFor(party), 0);
});
