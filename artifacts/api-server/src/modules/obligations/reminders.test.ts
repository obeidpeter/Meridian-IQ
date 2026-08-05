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
  engagementsTable,
  obligationReminderSendsTable,
} from "@workspace/db";
import { setFlag } from "../flags/flags.ts";
import {
  setMessageTransport,
  resetMessageTransport,
} from "../messaging/messaging.ts";
import { recipientRefFor } from "../messaging/recipient-ref.ts";
import { createObligation, updateObligationStatus } from "./obligations.ts";
import {
  sweepObligationReminders,
  OBLIGATION_STALE_OVERDUE_DAYS,
} from "./reminders.ts";
import { makeFlagGuard } from "../../test-helpers/flags.ts";
import { lagosDateOffset, makeRunSalt } from "../../test-helpers/fixtures.ts";

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

// The fan-out's own recipient derivation, imported so the assertion key tying
// message rows back to a fixture party can never drift (the recipient-ref.ts
// covenant).
const refFor = recipientRefFor;

const DAY_MS = 24 * 60 * 60 * 1000;
const lagosDaysFromNow = lagosDateOffset;

// Flag save/restore: the sweep tests flip messaging_notifications, so put it
// back exactly as found (delete when it did not pre-exist).
const flagGuard = makeFlagGuard(FLAG);

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
  await flagGuard.saveAndSet(true);
  const db = getDb();
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
  // The sweep only nudges clients the firm ACTIVELY serves (the
  // live-engagement wall): every fixture client holds an open engagement,
  // as a real obligation's client would. The wall's own test below runs a
  // party WITHOUT one.
  await db.insert(engagementsTable).values(
    ALL_CLIENTS.map((clientPartyId, i) => ({
      firmId,
      clientPartyId,
      type: "readiness_assessment",
      status: "open" as const,
      title: `obl rem ${i} ${SALT}`,
    })),
  );
});

after(async () => {
  await flagGuard.restore();
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

test("a dormant relationship stops the sends — the live-engagement wall", async () => {
  // A party the firm holds NO open/in_progress engagement for: offboarding
  // archives every engagement (and deletes the client logins that could
  // have silenced alerts), and a dormant book must not keep nudging either.
  // The obligation stays open — evidence of an unresolved matter — and no
  // claim slot is consumed, so re-opening the engagement RESUMES the
  // reminders instead of finding the threshold already burned.
  const clientDormant = randomUUID();
  const db = getDb();
  await db.insert(partiesTable).values({
    id: clientDormant,
    type: "client_business",
    legalName: `Obligation Reminder Dormant ${SALT}`,
    tin: "20000900-0009",
    street: "9 Broad St",
    city: "Lagos",
  });
  await db.insert(consentRecordsTable).values({
    partyId: clientDormant,
    layer: 1,
    action: "grant",
    scope: "compliance",
    basis: "contract",
    channel: "test",
  });
  const obligation = await obligationFor(clientDormant, lagosDaysFromNow(2));

  await drainReminders();
  assert.equal(
    (await remindersFor(obligation.id)).length,
    0,
    "no engagement, no claim — the slot is not burned",
  );
  assert.equal((await messagesFor(clientDormant)).length, 0);

  // The relationship resumes: the same threshold now claims and sends.
  await db.insert(engagementsTable).values({
    firmId,
    clientPartyId: clientDormant,
    type: "readiness_assessment",
    status: "open",
    title: `obl rem dormant ${SALT}`,
  });
  await drainReminders();
  const claims = await remindersFor(obligation.id);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].kind, "due_soon");
  assert.ok((await messagesFor(clientDormant)).length > 0, "the nudge landed");
});
