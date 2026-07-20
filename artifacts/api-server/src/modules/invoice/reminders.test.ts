import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  getDb,
  firmsTable,
  partiesTable,
  usersTable,
  invoicesTable,
  messagesTable,
  alertPreferencesTable,
  consentRecordsTable,
  deadlineReminderSendsTable,
  featureFlagsTable,
} from "@workspace/db";
import { setFlag } from "../flags/flags.ts";
import {
  setMessageTransport,
  resetMessageTransport,
} from "../messaging/messaging.ts";
import { createDraft } from "./service.ts";
import {
  sweepDeadlineReminders,
  DUE_SOON_DAYS,
  STALE_OVERDUE_DAYS,
} from "./reminders.ts";
import { SUBMISSION_WINDOW_DAYS } from "./compliance-window.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// The deadline-reminder sweep: once per (invoice, threshold), through the
// client's enabled channels, honoring the deadline-alerts opt-out and the
// messaging kill flag. Fixtures are salted — the ledger and the shared DB
// persist across runs.

const SALT = makeRunSalt();
const FLAG = "messaging_notifications";

const firmId = randomUUID();
const userId = randomUUID();
const supplierDueSoon = randomUUID();
const supplierOverdue = randomUUID();
const supplierOptedOut = randomUUID();
const supplierDark = randomUUID();
const supplierStale = randomUUID();
const supplierRevoked = randomUUID();
const supplierFailing = randomUUID();

// Matches the module's internal recipient derivation (letters of the uuid):
// the assertion key tying message rows back to a fixture party.
const refFor = (partyId: string) =>
  `ref-${partyId.replace(/[^a-z]/gi, "").slice(0, 16) || "client"}`;

const DAY_MS = 24 * 60 * 60 * 1000;
const isoDaysAgo = (days: number) =>
  new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);

// Issue dates relative to the statutory window: deadline = issue + 7d.
const DUE_SOON_ISSUE = isoDaysAgo(SUBMISSION_WINDOW_DAYS - 2); // ~2 days left
const OVERDUE_ISSUE = isoDaysAgo(SUBMISSION_WINDOW_DAYS + 3); // ~3 days past

// Flag save/restore: the sweep tests flip messaging_notifications, so put it
// back exactly as found (delete when it did not pre-exist).
let flagWasEnabled: boolean | null = null;

let n = 0;
async function draftFor(supplierPartyId: string, issueDate: string) {
  n += 1;
  const bundle = await createDraft(
    {
      firmId,
      supplierPartyId,
      buyerPartyId: supplierDueSoon, // any complete party works as buyer
      invoiceNumber: `REM-${SALT}-${n}`,
      issueDate,
      dueDate: null,
      lines: [
        { description: "Goods", quantity: "1", unitPrice: "1000", vatRate: "0.075" },
      ],
    },
    userId,
  );
  return bundle.invoice;
}

async function remindersFor(invoiceId: string) {
  return getDb()
    .select()
    .from(deadlineReminderSendsTable)
    .where(eq(deadlineReminderSendsTable.invoiceId, invoiceId));
}

async function messagesFor(partyId: string) {
  return getDb()
    .select()
    .from(messagesTable)
    .where(
      and(
        eq(messagesTable.recipientRef, refFor(partyId)),
        eq(messagesTable.templateKey, "deadline_reminder"),
      ),
    );
}

// The shared DB accumulates unsubmitted fixtures from every suite that ever
// ran, and one pass is bounded — drain until the sweep claims nothing so the
// assertions see this file's fixtures processed.
async function drainReminders(now?: Date) {
  while ((await sweepDeadlineReminders(now)) > 0) {
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
    .values({ id: userId, email: `rem-${SALT}@test.local` })
    .onConflictDoNothing();
  await db.insert(firmsTable).values({ id: firmId, name: `Reminder Firm ${SALT}` });
  await db.insert(partiesTable).values(
    [
      supplierDueSoon,
      supplierOverdue,
      supplierOptedOut,
      supplierDark,
      supplierStale,
      supplierRevoked,
      supplierFailing,
    ].map(
      (id, i) => ({
        id,
        type: "client_business" as const,
        legalName: `Reminder Client ${i} ${SALT}`,
        tin: `10000${i}00-0009`,
        street: `${i} Marina Rd`,
        city: "Lagos",
      }),
    ),
  );
  // Alert fan-out is gated on layer-1 consent (CORE-03): grant it for every
  // fixture party; the revocation test layers a revoke on top for its party.
  await db.insert(consentRecordsTable).values(
    [
      supplierDueSoon,
      supplierOverdue,
      supplierOptedOut,
      supplierDark,
      supplierStale,
      supplierRevoked,
      supplierFailing,
    ].map((partyId) => ({
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

test("due-soon invoice reminds once through default channels", async () => {
  const invoice = await draftFor(supplierDueSoon, DUE_SOON_ISSUE);
  await drainReminders();

  const ledger = await remindersFor(invoice.id);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].kind, "due_soon");
  assert.equal(ledger[0].clientPartyId, supplierDueSoon);

  // No prefs row: table defaults — whatsapp + email on, sms off.
  const msgs = await messagesFor(supplierDueSoon);
  assert.deepEqual(msgs.map((m) => m.channel).sort(), ["email", "whatsapp"]);
  // Every row carries the REAL recipient identity the notification inbox
  // scopes by (fan-out stamps recipient_party_id; the ref is display-only).
  assert.ok(msgs.every((m) => m.recipientPartyId === supplierDueSoon));

  // Second pass: the ledger row blocks a re-send.
  await drainReminders();
  assert.equal((await remindersFor(invoice.id)).length, 1);
  assert.equal((await messagesFor(supplierDueSoon)).length, msgs.length);
});

test("overdue invoice gets the overdue threshold; due_soon later still distinct", async () => {
  const invoice = await draftFor(supplierOverdue, OVERDUE_ISSUE);
  await drainReminders();
  const ledger = await remindersFor(invoice.id);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].kind, "overdue");
});

test("an invoice reminded at due_soon is reminded again when it goes overdue", async () => {
  const invoice = await draftFor(supplierDueSoon, DUE_SOON_ISSUE);
  await drainReminders();
  // Time-travel: the same invoice, DUE_SOON_DAYS+3 days later, is now past
  // its deadline — the overdue threshold is a separate once-only slot.
  const later = new Date(Date.now() + (DUE_SOON_DAYS + 3) * DAY_MS);
  await drainReminders(later);
  const kinds = (await remindersFor(invoice.id)).map((r) => r.kind).sort();
  assert.deepEqual(kinds, ["due_soon", "overdue"]);
});

test("deadline-alerts opt-out suppresses sends but still claims the slot", async () => {
  await getDb()
    .insert(alertPreferencesTable)
    .values({ clientPartyId: supplierOptedOut, deadlineAlerts: false })
    .onConflictDoNothing();
  const invoice = await draftFor(supplierOptedOut, DUE_SOON_ISSUE);
  await drainReminders();

  assert.equal((await remindersFor(invoice.id)).length, 1);
  assert.equal((await messagesFor(supplierOptedOut)).length, 0);
});

test("flag dark: slot claimed, nothing sent — enabling later does not backfill", async () => {
  await setFlag(FLAG, false);
  try {
    const invoice = await draftFor(supplierDark, DUE_SOON_ISSUE);
    await drainReminders();
    assert.equal((await remindersFor(invoice.id)).length, 1);
    assert.equal((await messagesFor(supplierDark)).length, 0);

    // Flag back on: the claimed slot must keep the old invoice silent.
    await setFlag(FLAG, true);
    await drainReminders();
    assert.equal((await messagesFor(supplierDark)).length, 0);
  } finally {
    await setFlag(FLAG, true);
  }
});

test("revoked layer-1 consent suppresses sends but still claims the slot", async () => {
  // The latest consent action wins: a revoke recorded after the grant takes
  // the party out of the deadline_alerts purpose entirely (CORE-03), so no
  // channel — messaging or push — may fire, while the idempotency slot is
  // still claimed so a later re-grant does not backfill the alert.
  await getDb().insert(consentRecordsTable).values({
    partyId: supplierRevoked,
    layer: 1,
    action: "revoke",
    scope: "compliance",
    basis: "contract",
    channel: "test",
  });
  const invoice = await draftFor(supplierRevoked, DUE_SOON_ISSUE);
  await drainReminders();

  assert.equal((await remindersFor(invoice.id)).length, 1);
  assert.equal((await messagesFor(supplierRevoked)).length, 0);
});

test("a send failure does not unclaim: at-most-once, never re-offered", async () => {
  // Every provider channel fails: the claim must still commit (claim-then-
  // send), the failures must land in the messages ledger, and a recovered
  // transport must NOT get a second attempt for the same slot.
  setMessageTransport(async () => ({ ok: false, error: "provider down" }));
  try {
    const invoice = await draftFor(supplierFailing, DUE_SOON_ISSUE);
    await drainReminders();

    const ledger = await remindersFor(invoice.id);
    assert.equal(ledger.length, 1, "slot claimed despite every send failing");
    assert.equal(ledger[0].kind, "due_soon");
    // Default channels (whatsapp + email), each walking its failover chain to
    // exhaustion: one failed row per attempted channel send.
    const failed = await messagesFor(supplierFailing);
    assert.equal(failed.length, 2);
    assert.ok(failed.every((m) => m.status === "failed"));

    // Transport recovers: the committed claim keeps the reminder retired —
    // better a missed nudge than a double alert.
    resetMessageTransport();
    await drainReminders();
    assert.equal((await remindersFor(invoice.id)).length, 1);
    assert.equal((await messagesFor(supplierFailing)).length, failed.length);
  } finally {
    resetMessageTransport();
  }
});

test("submitted invoices never remind", async () => {
  // A draft the sweep would match, moved out of the unsubmitted set by hand
  // (validated stays in; submitted leaves).
  const invoice = await draftFor(supplierDueSoon, DUE_SOON_ISSUE);
  await getDb()
    .update(invoicesTable)
    .set({ status: "submitted" })
    .where(eq(invoicesTable.id, invoice.id));
  await drainReminders();
  assert.equal((await remindersFor(invoice.id)).length, 0);
});

test("ancient overdue invoices claim silently — no day-one blast", async () => {
  const invoice = await draftFor(
    supplierStale,
    isoDaysAgo(SUBMISSION_WINDOW_DAYS + STALE_OVERDUE_DAYS + 10),
  );
  await drainReminders();
  const ledger = await remindersFor(invoice.id);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].kind, "overdue");
  assert.equal((await messagesFor(supplierStale)).length, 0);
});
