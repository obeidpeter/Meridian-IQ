import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  getDb,
  firmsTable,
  partiesTable,
  usersTable,
  messagesTable,
  alertPreferencesTable,
  consentRecordsTable,
  obligationReminderSendsTable,
  featureFlagsTable,
} from "@workspace/db";
import { setFlag } from "../flags/flags.ts";
import {
  setMessageTransport,
  resetMessageTransport,
} from "../messaging/messaging.ts";
import { createObligation, updateObligationStatus } from "./obligations.ts";
import {
  sweepObligationReminders,
  OBLIGATION_STALE_OVERDUE_DAYS,
} from "./reminders.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// The obligation deadline-reminder sweep (the invoice reminders.test.ts
// mirror): once per (obligation, threshold), through the client's enabled
// channels, honoring the deadline-alerts opt-out and the messaging kill flag.
// Fixtures are salted — the ledger and the shared DB persist across runs.

const SALT = makeRunSalt();
const FLAG = "messaging_notifications";

const firmId = randomUUID();
const userId = randomUUID();
const clientDueSoon = randomUUID();
const clientOverdue = randomUUID();
const clientTransition = randomUUID();
const clientOptedOut = randomUUID();
const clientDark = randomUUID();
const clientStale = randomUUID();
const clientFailing = randomUUID();
const clientAnswered = randomUUID();

const ALL_CLIENTS = [
  clientDueSoon,
  clientOverdue,
  clientTransition,
  clientOptedOut,
  clientDark,
  clientStale,
  clientFailing,
  clientAnswered,
];

// Matches the fan-out's recipient derivation (letters of the uuid): the
// assertion key tying message rows back to a fixture party.
const refFor = (partyId: string) =>
  `ref-${partyId.replace(/[^a-z]/gi, "").slice(0, 16) || "client"}`;

const DAY_MS = 24 * 60 * 60 * 1000;
const lagosDaysFromNow = (days: number) =>
  new Date(Date.now() + days * DAY_MS + 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

// Flag save/restore: the sweep tests flip messaging_notifications, so put it
// back exactly as found (delete when it did not pre-exist).
let flagWasEnabled: boolean | null = null;

async function obligationFor(clientPartyId: string, responseDueDate: string) {
  return createObligation(
    firmId,
    {
      clientPartyId,
      noticeType: "assessment",
      authority: "firs",
      responseDueDate,
    },
    userId,
  );
}

async function remindersFor(obligationId: string) {
  return getDb()
    .select()
    .from(obligationReminderSendsTable)
    .where(eq(obligationReminderSendsTable.obligationId, obligationId));
}

async function messagesFor(partyId: string) {
  return getDb()
    .select()
    .from(messagesTable)
    .where(
      and(
        eq(messagesTable.recipientRef, refFor(partyId)),
        inArray(messagesTable.templateKey, [
          "obligation_due_soon",
          "obligation_overdue",
        ]),
      ),
    );
}

// The shared DB accumulates open obligations from every suite that ever ran,
// and one pass is bounded — drain until the sweep claims nothing so the
// assertions see this file's fixtures processed.
async function drainReminders(now?: Date) {
  while ((await sweepObligationReminders(now)) > 0) {
    /* keep sweeping */
  }
}

before(async () => {
  const db = getDb();
  const [existing] = await db
    .select()
    .from(featureFlagsTable)
    .where(eq(featureFlagsTable.key, FLAG))
    .limit(1);
  flagWasEnabled = existing ? existing.enabled : null;
  await db
    .insert(featureFlagsTable)
    .values({ key: FLAG, enabled: true, description: "test" })
    .onConflictDoUpdate({
      target: featureFlagsTable.key,
      set: { enabled: true },
    });

  await db
    .insert(usersTable)
    .values({ id: userId, email: `obl-rem-${SALT}@test.local` })
    .onConflictDoNothing();
  await db
    .insert(firmsTable)
    .values({ id: firmId, name: `Obligation Reminder Firm ${SALT}` });
  await db.insert(partiesTable).values(
    ALL_CLIENTS.map((id, i) => ({
      id,
      type: "client_business" as const,
      legalName: `Obligation Reminder Client ${i} ${SALT}`,
      tin: `20000${i}00-0009`,
      street: `${i} Broad St`,
      city: "Lagos",
    })),
  );
  // Alert fan-out is gated on layer-1 consent (CORE-03 — the shared
  // deadline_alerts purpose): grant it for every fixture party.
  await db.insert(consentRecordsTable).values(
    ALL_CLIENTS.map((partyId) => ({
      partyId,
      layer: 1,
      action: "grant" as const,
      scope: "compliance",
      basis: "contract",
      channel: "test",
    })),
  );
});

after(async () => {
  const db = getDb();
  if (flagWasEnabled === null) {
    await db.delete(featureFlagsTable).where(eq(featureFlagsTable.key, FLAG));
  } else {
    await setFlag(FLAG, flagWasEnabled);
  }
});

test("due-soon obligation reminds once through default channels", async () => {
  const obligation = await obligationFor(clientDueSoon, lagosDaysFromNow(2));
  await drainReminders();

  const ledger = await remindersFor(obligation.id);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].kind, "due_soon");
  assert.equal(ledger[0].clientPartyId, clientDueSoon);
  assert.equal(ledger[0].firmId, firmId);

  // No prefs row: table defaults — whatsapp + email on, sms off — under the
  // due-soon template.
  const msgs = await messagesFor(clientDueSoon);
  assert.deepEqual(msgs.map((m) => m.channel).sort(), ["email", "whatsapp"]);
  assert.ok(msgs.every((m) => m.templateKey === "obligation_due_soon"));
  assert.ok(msgs.every((m) => m.recipientPartyId === clientDueSoon));
  // Pointer-only entity ref (SEC-12): letters of the obligation id.
  assert.ok(msgs.every((m) => m.entityId?.startsWith("obl-")));

  // Second pass: the ledger row blocks a re-send.
  await drainReminders();
  assert.equal((await remindersFor(obligation.id)).length, 1);
  assert.equal((await messagesFor(clientDueSoon)).length, msgs.length);
});

test("overdue obligation gets the overdue threshold and template", async () => {
  const obligation = await obligationFor(clientOverdue, lagosDaysFromNow(-3));
  await drainReminders();
  const ledger = await remindersFor(obligation.id);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].kind, "overdue");
  const msgs = await messagesFor(clientOverdue);
  assert.ok(msgs.length > 0);
  assert.ok(msgs.every((m) => m.templateKey === "obligation_overdue"));
});

test("an obligation reminded at due_soon is reminded again when it goes overdue", async () => {
  const obligation = await obligationFor(clientTransition, lagosDaysFromNow(2));
  await drainReminders();
  assert.deepEqual(
    (await remindersFor(obligation.id)).map((r) => r.kind),
    ["due_soon"],
  );
  // Time-travel: 5 days later the response date is past — the overdue
  // threshold is a separate once-only slot.
  const later = new Date(Date.now() + 5 * DAY_MS);
  await drainReminders(later);
  const kinds = (await remindersFor(obligation.id)).map((r) => r.kind).sort();
  assert.deepEqual(kinds, ["due_soon", "overdue"]);
});

test("deadline-alerts opt-out suppresses sends but still claims the slot", async () => {
  await getDb()
    .insert(alertPreferencesTable)
    .values({ clientPartyId: clientOptedOut, deadlineAlerts: false })
    .onConflictDoNothing();
  const obligation = await obligationFor(clientOptedOut, lagosDaysFromNow(2));
  await drainReminders();

  assert.equal((await remindersFor(obligation.id)).length, 1);
  assert.equal((await messagesFor(clientOptedOut)).length, 0);
});

test("flag dark: slot claimed, nothing sent — enabling later does not backfill", async () => {
  await setFlag(FLAG, false);
  try {
    const obligation = await obligationFor(clientDark, lagosDaysFromNow(2));
    await drainReminders();
    assert.equal((await remindersFor(obligation.id)).length, 1);
    assert.equal((await messagesFor(clientDark)).length, 0);

    // Flag back on: the claimed slot must keep the old obligation silent.
    await setFlag(FLAG, true);
    await drainReminders();
    assert.equal((await messagesFor(clientDark)).length, 0);
  } finally {
    await setFlag(FLAG, true);
  }
});

test("ancient overdue obligations claim silently — no day-one blast", async () => {
  const obligation = await obligationFor(
    clientStale,
    lagosDaysFromNow(-(OBLIGATION_STALE_OVERDUE_DAYS + 10)),
  );
  await drainReminders();
  const ledger = await remindersFor(obligation.id);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].kind, "overdue");
  assert.equal((await messagesFor(clientStale)).length, 0);
});

test("a send failure does not unclaim: at-most-once, never re-offered", async () => {
  // Every provider channel fails: the claim must still commit (claim-then-
  // send), the failures must land in the messages ledger, and a recovered
  // transport must NOT get a second attempt for the same slot.
  setMessageTransport(async () => ({ ok: false, error: "provider down" }));
  try {
    const obligation = await obligationFor(clientFailing, lagosDaysFromNow(2));
    await drainReminders();

    const ledger = await remindersFor(obligation.id);
    assert.equal(ledger.length, 1, "slot claimed despite every send failing");
    assert.equal(ledger[0].kind, "due_soon");
    // Default channels (whatsapp + email), each walking its failover chain
    // to exhaustion: one failed row per attempted channel send.
    const failed = await messagesFor(clientFailing);
    assert.equal(failed.length, 2);
    assert.ok(failed.every((m) => m.status === "failed"));

    // Transport recovers: the committed claim keeps the reminder retired —
    // better a missed nudge than a double alert.
    resetMessageTransport();
    await drainReminders();
    assert.equal((await remindersFor(obligation.id)).length, 1);
    assert.equal((await messagesFor(clientFailing)).length, failed.length);
  } finally {
    resetMessageTransport();
  }
});

test("responded and closed obligations never remind", async () => {
  const obligation = await obligationFor(clientAnswered, lagosDaysFromNow(1));
  await updateObligationStatus(
    obligation.id,
    firmId,
    "responded",
    undefined,
    userId,
  );
  await drainReminders();
  assert.equal((await remindersFor(obligation.id)).length, 0);
  assert.equal((await messagesFor(clientAnswered)).length, 0);
});
