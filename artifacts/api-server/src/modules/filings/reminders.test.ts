import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  getDb,
  firmsTable,
  partiesTable,
  messagesTable,
  alertPreferencesTable,
  consentRecordsTable,
  engagementsTable,
  filingReturnsTable,
  filingReminderSendsTable,
  type FilingReturn,
} from "@workspace/db";
import { setFlag } from "../flags/flags.ts";
import { recipientRefFor } from "../messaging/recipient-ref.ts";
import {
  sweepFilingReminders,
  FILING_STALE_OVERDUE_DAYS,
} from "./reminders.ts";
import { makeFlagGuard } from "../../test-helpers/flags.ts";
import { lagosDateOffset, makeRunSalt } from "../../test-helpers/fixtures.ts";

// The filing deadline-reminder sweep (the obligations reminders.test.ts
// mirror): once per (filing, threshold), through the client's enabled
// channels, honoring the deadline-alerts opt-out and the messaging kill flag.
// Fixtures are salted — the ledger and the shared DB persist across runs.

const SALT = makeRunSalt();
const FLAG = "messaging_notifications";

const firmId = randomUUID();
const clientDueSoon = randomUUID();
const clientOverdue = randomUUID();
const clientTransition = randomUUID();
const clientOptedOut = randomUUID();
const clientDark = randomUUID();
const clientStale = randomUUID();
const clientFiled = randomUUID();

const ALL_CLIENTS = [
  clientDueSoon,
  clientOverdue,
  clientTransition,
  clientOptedOut,
  clientDark,
  clientStale,
  clientFiled,
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

// Seed one register row directly (the countOpenFilings test's discipline —
// reminders classify whatever the register holds, however it was minted).
// A far-past period keeps the natural key clear of any sweep-minted rows.
async function filingFor(
  clientPartyId: string,
  dueDate: string,
  status: FilingReturn["status"] = "upcoming",
): Promise<FilingReturn> {
  const [row] = await getDb()
    .insert(filingReturnsTable)
    .values({
      firmId,
      clientPartyId,
      taxType: "vat",
      period: "2097-01",
      dueDate,
      status,
    })
    .returning();
  return row;
}

async function remindersFor(filingId: string) {
  return getDb()
    .select()
    .from(filingReminderSendsTable)
    .where(eq(filingReminderSendsTable.filingId, filingId));
}

async function messagesFor(partyId: string) {
  return getDb()
    .select()
    .from(messagesTable)
    .where(
      and(
        eq(messagesTable.recipientRef, refFor(partyId)),
        inArray(messagesTable.templateKey, [
          "filing_due_soon",
          "filing_overdue",
        ]),
      ),
    );
}

// The shared DB accumulates unfiled returns from every suite that ever ran,
// and one pass is bounded — drain until the sweep claims nothing so the
// assertions see this file's fixtures processed.
async function drainReminders(now?: Date) {
  while ((await sweepFilingReminders(now)) > 0) {
    /* keep sweeping */
  }
}

before(async () => {
  await flagGuard.saveAndSet(true);
  const db = getDb();
  await db.insert(firmsTable).values({
    id: firmId,
    name: `Filing Reminder Firm ${SALT}`,
  });
  await db.insert(partiesTable).values(
    ALL_CLIENTS.map((id, i) => ({
      id,
      type: "client_business" as const,
      legalName: `Filing Reminder Client ${i} ${SALT}`,
      tin: `30000${i}00-0009`,
      street: `${i} Marina Rd`,
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
  // as a real register row's client would. The wall's own test below runs a
  // party WITHOUT one.
  await db.insert(engagementsTable).values(
    ALL_CLIENTS.map((clientPartyId, i) => ({
      firmId,
      clientPartyId,
      type: "readiness_assessment" as const,
      status: "open" as const,
      title: `fil rem ${i} ${SALT}`,
    })),
  );
});

after(async () => {
  await flagGuard.restore();
});

test("due-soon filing reminds once through default channels", async () => {
  const filing = await filingFor(clientDueSoon, lagosDaysFromNow(2));
  await drainReminders();

  const ledger = await remindersFor(filing.id);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].kind, "due_soon");
  assert.equal(ledger[0].clientPartyId, clientDueSoon);
  assert.equal(ledger[0].firmId, firmId);

  // No prefs row: table defaults — whatsapp + email on, sms off — under the
  // due-soon template.
  const msgs = await messagesFor(clientDueSoon);
  assert.deepEqual(msgs.map((m) => m.channel).sort(), ["email", "whatsapp"]);
  assert.ok(msgs.every((m) => m.templateKey === "filing_due_soon"));
  assert.ok(msgs.every((m) => m.recipientPartyId === clientDueSoon));
  // Pointer-only entity ref (SEC-12): letters of the filing id.
  assert.ok(msgs.every((m) => m.entityId?.startsWith("fil-")));
  assert.ok(msgs.every((m) => m.entityType === "filing_return"));

  // Second pass: the ledger row blocks a re-send — claim-at-most-once per
  // (filing, kind).
  await drainReminders();
  assert.equal((await remindersFor(filing.id)).length, 1);
  assert.equal((await messagesFor(clientDueSoon)).length, msgs.length);
});

test("overdue filing gets the overdue threshold and template", async () => {
  const filing = await filingFor(clientOverdue, lagosDaysFromNow(-3));
  await drainReminders();
  const ledger = await remindersFor(filing.id);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].kind, "overdue");
  const msgs = await messagesFor(clientOverdue);
  assert.ok(msgs.length > 0);
  assert.ok(msgs.every((m) => m.templateKey === "filing_overdue"));
});

test("a filing reminded at due_soon is reminded again when it goes overdue", async () => {
  const filing = await filingFor(clientTransition, lagosDaysFromNow(2));
  await drainReminders();
  assert.deepEqual(
    (await remindersFor(filing.id)).map((r) => r.kind),
    ["due_soon"],
  );
  // Time-travel: 5 days later the due date is past — the overdue threshold
  // is a separate once-only slot.
  const later = new Date(Date.now() + 5 * DAY_MS);
  await drainReminders(later);
  const kinds = (await remindersFor(filing.id)).map((r) => r.kind).sort();
  assert.deepEqual(kinds, ["due_soon", "overdue"]);
});

test("deadline-alerts opt-out suppresses sends but still claims the slot", async () => {
  await getDb()
    .insert(alertPreferencesTable)
    .values({ clientPartyId: clientOptedOut, deadlineAlerts: false })
    .onConflictDoNothing();
  const filing = await filingFor(clientOptedOut, lagosDaysFromNow(2));
  await drainReminders();

  assert.equal((await remindersFor(filing.id)).length, 1);
  assert.equal((await messagesFor(clientOptedOut)).length, 0);
});

test("flag dark: slot claimed, nothing sent — enabling later does not backfill", async () => {
  await setFlag(FLAG, false);
  try {
    const filing = await filingFor(clientDark, lagosDaysFromNow(2));
    await drainReminders();
    assert.equal((await remindersFor(filing.id)).length, 1);
    assert.equal((await messagesFor(clientDark)).length, 0);

    // Flag back on: the claimed slot must keep the old filing silent.
    await setFlag(FLAG, true);
    await drainReminders();
    assert.equal((await messagesFor(clientDark)).length, 0);
  } finally {
    await setFlag(FLAG, true);
  }
});

test("ancient overdue filings claim silently — no day-one blast", async () => {
  const filing = await filingFor(
    clientStale,
    lagosDaysFromNow(-(FILING_STALE_OVERDUE_DAYS + 10)),
  );
  await drainReminders();
  const ledger = await remindersFor(filing.id);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].kind, "overdue");
  assert.equal((await messagesFor(clientStale)).length, 0);
});

test("filed returns never remind", async () => {
  const filing = await filingFor(clientFiled, lagosDaysFromNow(1), "filed");
  await drainReminders();
  assert.equal((await remindersFor(filing.id)).length, 0);
  assert.equal((await messagesFor(clientFiled)).length, 0);
});

test("a dormant relationship stops the sends — the live-engagement wall", async () => {
  // A party the firm holds NO open/in_progress engagement for: offboarding
  // archives every engagement (and deletes the client logins that could
  // have silenced alerts), and a dormant book must not keep nudging either.
  // The register row stays visible — evidence of an unfiled return — and no
  // claim slot is consumed, so re-opening the engagement RESUMES the
  // reminders instead of finding the threshold already burned.
  const clientDormant = randomUUID();
  const db = getDb();
  await db.insert(partiesTable).values({
    id: clientDormant,
    type: "client_business",
    legalName: `Filing Reminder Dormant ${SALT}`,
    tin: "30000900-0009",
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
  const filing = await filingFor(clientDormant, lagosDaysFromNow(2));

  await drainReminders();
  assert.equal(
    (await remindersFor(filing.id)).length,
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
    title: `fil rem dormant ${SALT}`,
  });
  await drainReminders();
  const claims = await remindersFor(filing.id);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].kind, "due_soon");
  assert.ok((await messagesFor(clientDormant)).length > 0, "the nudge landed");
});
