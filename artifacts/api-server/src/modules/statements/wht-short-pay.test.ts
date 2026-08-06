import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  getDb,
  bankStatementsTable,
  bankStatementLinesTable,
  engagementsTable,
  firmsTable,
  invoicesTable,
  matchProposalsTable,
  outboxTable,
  partiesTable,
  usersTable,
  whtCreditsTable,
} from "@workspace/db";
import { drain } from "../pipeline/pipeline.ts";
import { acceptProposal } from "./service.ts";
import { recordWhtCredit } from "../wht/credits.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// The WHT short-pay lane (WHT Desk): a receivable candidate carrying a WHT
// category exposes expectedWht to the matcher; a line at grandTotal −
// expectedWht scores through the adjusted basis and the proposal records
// whtShortPay in its features; ACCEPTING that proposal settles the invoice
// AND mints the wht_credits row in the same transaction — with the amount
// recomputed in SQL, never read off the jsonb snapshot — while the unique
// invoiceId key dedupes against a manual record.

const SALT = makeRunSalt();
const firmId = randomUUID();
const clientParty = randomUUID(); // engaged supplier — the statement's owner
const buyerParty = randomUUID();
const userId = randomUUID();

let whtInvId: string; // services_5: subtotal 100000, grand 107500, expected 5000
let plainInvId: string; // no category: the control lane
let manualInvId: string; // rent_10: subtotal 40000, grand 43000, expected 4000

function dateOffset(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Drain the outbox until the given event is terminal (debit-lane pattern).
async function drainUntil(eventId: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await drain();
    const [row] = await getDb()
      .select({ status: outboxTable.status })
      .from(outboxTable)
      .where(eq(outboxTable.id, eventId));
    if (row && (row.status === "done" || row.status === "dead")) return;
  }
  assert.fail("outbox event did not settle within the drain budget");
}

async function seedStatement(lines: {
  amount: string;
  direction: "credit" | "debit";
  narration: string;
}[]): Promise<{ statementId: string; lineIds: string[] }> {
  const [statement] = await getDb()
    .insert(bankStatementsTable)
    .values({
      firmId,
      clientPartyId: clientParty,
      formatKey: "test_fixture",
      status: "committed",
      lineCount: lines.length,
      parsedCount: lines.length,
      uploadedByUserId: userId,
    })
    .returning();
  const inserted = await getDb()
    .insert(bankStatementLinesTable)
    .values(
      lines.map((l, i) => ({
        statementId: statement.id,
        lineNo: i + 1,
        valueDate: dateOffset(-1),
        amount: l.amount,
        direction: l.direction,
        narration: l.narration,
        counterpartyRef: null,
        parseStatus: "parsed" as const,
        rawLine: `${l.direction},${l.amount},${l.narration}`,
      })),
    )
    .returning({ id: bankStatementLinesTable.id });
  const [event] = await getDb()
    .insert(outboxTable)
    .values({
      aggregateType: "bank_statement",
      aggregateId: statement.id,
      type: "statement.reconcile",
      payload: { statementId: statement.id },
    })
    .returning({ id: outboxTable.id });
  await drainUntil(event.id);
  return { statementId: statement.id, lineIds: inserted.map((r) => r.id) };
}

async function proposalFor(lineId: string, invoiceId: string) {
  const [row] = await getDb()
    .select()
    .from(matchProposalsTable)
    .where(
      and(
        eq(matchProposalsTable.statementLineId, lineId),
        eq(matchProposalsTable.invoiceId, invoiceId),
      ),
    );
  return row;
}

async function creditsFor(invoiceId: string) {
  return getDb()
    .select()
    .from(whtCreditsTable)
    .where(eq(whtCreditsTable.invoiceId, invoiceId));
}

before(async () => {
  const db = getDb();
  await db
    .insert(usersTable)
    .values({ id: userId, email: `wht-shortpay-${SALT}@test.local` })
    .onConflictDoNothing();
  await db.insert(firmsTable).values({ id: firmId, name: `WHT SP Firm ${SALT}` });
  await db.insert(partiesTable).values([
    { id: clientParty, type: "client_business", legalName: `WHT SP Client ${SALT}` },
    { id: buyerParty, type: "buyer", legalName: `Corporate Buyer Plc ${SALT}` },
  ]);
  await db.insert(engagementsTable).values({
    firmId,
    clientPartyId: clientParty,
    type: "retainer",
    title: `wht sp ${SALT}`,
  });
  whtInvId = randomUUID();
  plainInvId = randomUUID();
  manualInvId = randomUUID();
  const receivable = (
    id: string,
    invoiceNumber: string,
    subtotal: string,
    vatTotal: string,
    grandTotal: string,
    whtCategory: string | null,
  ) => ({
    id,
    firmId,
    supplierPartyId: clientParty,
    buyerPartyId: buyerParty,
    invoiceNumber,
    status: "stamped" as const,
    issueDate: dateOffset(-10),
    subtotal,
    vatTotal,
    grandTotal,
    whtCategory,
  });
  await db.insert(invoicesTable).values([
    receivable(whtInvId, `SP-WHT-${SALT}`, "100000.00", "7500.00", "107500.00", "services_5"),
    receivable(plainInvId, `SP-PLAIN-${SALT}`, "46511.63", "3488.37", "50000.00", null),
    receivable(manualInvId, `SP-MAN-${SALT}`, "40000.00", "3000.00", "43000.00", "rent_10"),
  ]);
});

test("accepting a short-pay proposal settles the invoice AND mints the credit", async () => {
  const seeded = await seedStatement([
    // grandTotal − expectedWht to the kobo: the WHT-adjusted basis scores 1.
    {
      amount: "102500.00",
      direction: "credit",
      narration: `NIP TRF CORPORATE BUYER/SP-WHT-${SALT}`,
    },
  ]);
  const proposal = await proposalFor(seeded.lineIds[0], whtInvId);
  assert.ok(proposal, "the short-pay line proposes against the invoice");
  assert.equal(
    (proposal.features as { whtShortPay?: boolean }).whtShortPay,
    true,
    "the adjusted basis win is recorded in the features",
  );

  const result = await acceptProposal(proposal.id, {
    userId,
    role: "firm_staff",
  });
  assert.equal(result.status, "accepted");
  assert.equal(result.invoiceStatus, "settled");

  const credits = await creditsFor(whtInvId);
  assert.equal(credits.length, 1, "accept-and-mint: exactly one credit");
  assert.equal(credits[0].category, "services_5");
  assert.equal(
    credits[0].amount,
    "5000.00",
    "the amount is the SQL-recomputed expectation, never the jsonb snapshot",
  );
  assert.equal(credits[0].source, "statement_match");
  assert.equal(credits[0].status, "awaiting_note");
  assert.equal(credits[0].clientPartyId, clientParty);
  assert.equal(
    credits[0].deductedDate,
    dateOffset(-1),
    "deducted on the line's value date",
  );
});

test("accepting a normal full-amount proposal mints nothing", async () => {
  const seeded = await seedStatement([
    {
      amount: "50000.00",
      direction: "credit",
      narration: `NIP TRF CORPORATE BUYER/SP-PLAIN-${SALT}`,
    },
  ]);
  const proposal = await proposalFor(seeded.lineIds[0], plainInvId);
  assert.ok(proposal);
  assert.equal(
    (proposal.features as { whtShortPay?: boolean }).whtShortPay,
    undefined,
  );
  const result = await acceptProposal(proposal.id, {
    userId,
    role: "firm_staff",
  });
  assert.equal(result.invoiceStatus, "settled");
  assert.equal((await creditsFor(plainInvId)).length, 0);
});

test("a manual record before the accept survives — one credit per invoice", async () => {
  // The human records the buyer's real figure first (3900, not the 4000
  // expectation).
  const manual = await recordWhtCredit(firmId, manualInvId, {
    amount: "3900.00",
    deductedDate: dateOffset(-2),
    source: "manual",
    recordedBy: userId,
  });
  assert.equal(manual.source, "manual");

  const seeded = await seedStatement([
    // 43000 − 4000: the adjusted basis scores 1 and flags the proposal.
    {
      amount: "39000.00",
      direction: "credit",
      narration: `NIP TRF CORPORATE BUYER/SP-MAN-${SALT}`,
    },
  ]);
  const proposal = await proposalFor(seeded.lineIds[0], manualInvId);
  assert.ok(proposal);
  assert.equal(
    (proposal.features as { whtShortPay?: boolean }).whtShortPay,
    true,
  );
  const result = await acceptProposal(proposal.id, {
    userId,
    role: "firm_staff",
  });
  assert.equal(result.invoiceStatus, "settled");

  // The unique invoiceId key deduped: the MANUAL row survives untouched.
  const credits = await creditsFor(manualInvId);
  assert.equal(credits.length, 1);
  assert.equal(credits[0].id, manual.id);
  assert.equal(credits[0].source, "manual");
  assert.equal(credits[0].amount, "3900.00");
});
