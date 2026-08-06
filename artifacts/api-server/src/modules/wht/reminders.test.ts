import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  getDb,
  firmsTable,
  partiesTable,
  invoicesTable,
  messagesTable,
  alertPreferencesTable,
  consentRecordsTable,
  engagementsTable,
  whtCreditsTable,
  whtReminderSendsTable,
  type WhtCredit,
} from "@workspace/db";
import { setFlag } from "../flags/flags.ts";
import { recipientRefFor } from "../messaging/recipient-ref.ts";
import {
  sweepWhtReminders,
  WHT_NOTE_CHASE_DAYS,
  WHT_STALE_OVERDUE_DAYS,
} from "./reminders.ts";
import { makeFlagGuard } from "../../test-helpers/flags.ts";
import { lagosDateOffset, makeRunSalt } from "../../test-helpers/fixtures.ts";

// The WHT credit-note chase sweep (the filings reminders.test.ts mirror):
// once per (credit, threshold), through the client's enabled channels,
// honoring the deadline-alerts opt-out and the messaging kill flag. The
// chase deadline is deducted_date + WHT_NOTE_CHASE_DAYS. Fixtures are
// salted — the ledger and the shared DB persist across runs.

const SALT = makeRunSalt();
const FLAG = "messaging_notifications";

const firmId = randomUUID();
const buyerParty = randomUUID();
const clientDueSoon = randomUUID();
const clientOverdue = randomUUID();
const clientTransition = randomUUID();
const clientOptedOut = randomUUID();
const clientDark = randomUUID();
const clientStale = randomUUID();
const clientReceived = randomUUID();

const ALL_CLIENTS = [
  clientDueSoon,
  clientOverdue,
  clientTransition,
  clientOptedOut,
  clientDark,
  clientStale,
  clientReceived,
];

const refFor = recipientRefFor;

const DAY_MS = 24 * 60 * 60 * 1000;

const flagGuard = makeFlagGuard(FLAG);

// Seed one credit directly (the countOpenFilings discipline — the sweep
// classifies whatever the ledger holds, however it was minted). Every credit
// needs its own invoice row (the FK); the invoice's category is irrelevant
// to the sweep — the credit's stored category is the fact.
async function creditFor(
  clientPartyId: string,
  deductedDate: string,
  status: WhtCredit["status"] = "awaiting_note",
): Promise<WhtCredit> {
  const invoiceId = randomUUID();
  await getDb().insert(invoicesTable).values({
    id: invoiceId,
    firmId,
    supplierPartyId: clientPartyId,
    buyerPartyId: buyerParty,
    invoiceNumber: `WR-${invoiceId.slice(0, 8)}-${SALT}`,
    status: "settled",
    issueDate: deductedDate,
    subtotal: "100000.00",
    vatTotal: "7500.00",
    grandTotal: "107500.00",
    whtCategory: "services_5",
  });
  const [row] = await getDb()
    .insert(whtCreditsTable)
    .values({
      firmId,
      clientPartyId,
      invoiceId,
      category: "services_5",
      amount: "5000.00",
      deductedDate,
      source: "manual",
      status,
      ...(status === "note_received"
        ? { noteReference: `WR-NOTE-${SALT}`, noteDate: deductedDate }
        : {}),
    })
    .returning();
  return row;
}

async function remindersFor(creditId: string) {
  return getDb()
    .select()
    .from(whtReminderSendsTable)
    .where(eq(whtReminderSendsTable.creditId, creditId));
}

async function messagesFor(partyId: string) {
  return getDb()
    .select()
    .from(messagesTable)
    .where(
      and(
        eq(messagesTable.recipientRef, refFor(partyId)),
        inArray(messagesTable.templateKey, [
          "wht_note_due_soon",
          "wht_note_overdue",
        ]),
      ),
    );
}

// The shared DB accumulates awaiting credits from every suite that ever ran,
// and one pass is bounded — drain until the sweep claims nothing.
async function drainReminders(now?: Date) {
  while ((await sweepWhtReminders(now)) > 0) {
    /* keep sweeping */
  }
}

before(async () => {
  await flagGuard.saveAndSet(true);
  const db = getDb();
  await db.insert(firmsTable).values({
    id: firmId,
    name: `WHT Reminder Firm ${SALT}`,
  });
  await db.insert(partiesTable).values([
    ...ALL_CLIENTS.map((id, i) => ({
      id,
      type: "client_business" as const,
      legalName: `WHT Reminder Client ${i} ${SALT}`,
      tin: `40000${i}00-0009`,
      street: `${i} Marina Rd`,
      city: "Lagos",
    })),
    {
      id: buyerParty,
      type: "buyer" as const,
      legalName: `WHT Reminder Buyer ${SALT}`,
    },
  ]);
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
  // live-engagement wall); the wall's own test below runs a party WITHOUT
  // one.
  await db.insert(engagementsTable).values(
    ALL_CLIENTS.map((clientPartyId, i) => ({
      firmId,
      clientPartyId,
      type: "readiness_assessment" as const,
      status: "open" as const,
      title: `wht rem ${i} ${SALT}`,
    })),
  );
});

after(async () => {
  await flagGuard.restore();
});

test("a credit near its chase deadline reminds once through default channels", async () => {
  // Deducted 28 days ago: the +30 deadline is 2 days out — due_soon.
  const credit = await creditFor(
    clientDueSoon,
    lagosDateOffset(-(WHT_NOTE_CHASE_DAYS - 2)),
  );
  await drainReminders();

  const ledger = await remindersFor(credit.id);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].kind, "due_soon");
  assert.equal(ledger[0].clientPartyId, clientDueSoon);
  assert.equal(ledger[0].firmId, firmId);

  // No prefs row: table defaults — whatsapp + email on, sms off — under the
  // due-soon template.
  const msgs = await messagesFor(clientDueSoon);
  assert.deepEqual(msgs.map((m) => m.channel).sort(), ["email", "whatsapp"]);
  assert.ok(msgs.every((m) => m.templateKey === "wht_note_due_soon"));
  assert.ok(msgs.every((m) => m.recipientPartyId === clientDueSoon));
  // Pointer-only entity ref (SEC-12): letters of the credit id.
  assert.ok(msgs.every((m) => m.entityId?.startsWith("whc-")));
  assert.ok(msgs.every((m) => m.entityType === "wht_credit"));

  // Second pass: the ledger row blocks a re-send — claim-at-most-once per
  // (credit, kind).
  await drainReminders();
  assert.equal((await remindersFor(credit.id)).length, 1);
  assert.equal((await messagesFor(clientDueSoon)).length, msgs.length);
});

test("a credit past its chase deadline gets the overdue threshold and template", async () => {
  const credit = await creditFor(
    clientOverdue,
    lagosDateOffset(-(WHT_NOTE_CHASE_DAYS + 3)),
  );
  await drainReminders();
  const ledger = await remindersFor(credit.id);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].kind, "overdue");
  const msgs = await messagesFor(clientOverdue);
  assert.ok(msgs.length > 0);
  assert.ok(msgs.every((m) => m.templateKey === "wht_note_overdue"));
});

test("a credit reminded at due_soon is reminded again when the chase goes overdue", async () => {
  const credit = await creditFor(
    clientTransition,
    lagosDateOffset(-(WHT_NOTE_CHASE_DAYS - 2)),
  );
  await drainReminders();
  assert.deepEqual(
    (await remindersFor(credit.id)).map((r) => r.kind),
    ["due_soon"],
  );
  // Time-travel: 5 days later the chase deadline is past — the overdue
  // threshold is a separate once-only slot.
  const later = new Date(Date.now() + 5 * DAY_MS);
  await drainReminders(later);
  const kinds = (await remindersFor(credit.id)).map((r) => r.kind).sort();
  assert.deepEqual(kinds, ["due_soon", "overdue"]);
});

test("deadline-alerts opt-out suppresses sends but still claims the slot", async () => {
  await getDb()
    .insert(alertPreferencesTable)
    .values({ clientPartyId: clientOptedOut, deadlineAlerts: false })
    .onConflictDoNothing();
  const credit = await creditFor(
    clientOptedOut,
    lagosDateOffset(-(WHT_NOTE_CHASE_DAYS - 2)),
  );
  await drainReminders();

  assert.equal((await remindersFor(credit.id)).length, 1);
  assert.equal((await messagesFor(clientOptedOut)).length, 0);
});

test("flag dark: slot claimed, nothing sent — enabling later does not backfill", async () => {
  await setFlag(FLAG, false);
  try {
    const credit = await creditFor(
      clientDark,
      lagosDateOffset(-(WHT_NOTE_CHASE_DAYS - 2)),
    );
    await drainReminders();
    assert.equal((await remindersFor(credit.id)).length, 1);
    assert.equal((await messagesFor(clientDark)).length, 0);

    // Flag back on: the claimed slot must keep the old credit silent.
    await setFlag(FLAG, true);
    await drainReminders();
    assert.equal((await messagesFor(clientDark)).length, 0);
  } finally {
    await setFlag(FLAG, true);
  }
});

test("ancient overdue chases claim silently — no day-one blast", async () => {
  const credit = await creditFor(
    clientStale,
    lagosDateOffset(-(WHT_NOTE_CHASE_DAYS + WHT_STALE_OVERDUE_DAYS + 10)),
  );
  await drainReminders();
  const ledger = await remindersFor(credit.id);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].kind, "overdue");
  assert.equal((await messagesFor(clientStale)).length, 0);
});

test("a received credit note never reminds", async () => {
  const credit = await creditFor(
    clientReceived,
    lagosDateOffset(-(WHT_NOTE_CHASE_DAYS + 3)),
    "note_received",
  );
  await drainReminders();
  assert.equal((await remindersFor(credit.id)).length, 0);
  assert.equal((await messagesFor(clientReceived)).length, 0);
});

test("a dormant relationship stops the sends — the live-engagement wall", async () => {
  // A party the firm holds NO open/in_progress engagement for: no claim slot
  // is consumed, so re-opening the engagement RESUMES the reminders instead
  // of finding the threshold already burned.
  const clientDormant = randomUUID();
  const db = getDb();
  await db.insert(partiesTable).values({
    id: clientDormant,
    type: "client_business",
    legalName: `WHT Reminder Dormant ${SALT}`,
    tin: "40000900-0009",
    street: "9 Marina Rd",
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
  const credit = await creditFor(
    clientDormant,
    lagosDateOffset(-(WHT_NOTE_CHASE_DAYS - 2)),
  );

  await drainReminders();
  assert.equal(
    (await remindersFor(credit.id)).length,
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
    title: `wht rem dormant ${SALT}`,
  });
  await drainReminders();
  const claims = await remindersFor(credit.id);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].kind, "due_soon");
  assert.ok((await messagesFor(clientDormant)).length > 0, "the nudge landed");
});
