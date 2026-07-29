import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  getDb,
  bankStatementsTable,
  bankStatementLinesTable,
  engagementsTable,
  featureFlagsTable,
  featureFlagOverridesTable,
  firmsTable,
  invoicesTable,
  invoiceLifecycleEventsTable,
  matchProposalsTable,
  outboxTable,
  partiesTable,
  settlementEventsTable,
  usersTable,
} from "@workspace/db";
import { drain } from "../pipeline/pipeline.ts";
import { acceptProposal } from "./service.ts";
import { bulkAcceptProposals } from "./bulk-accept.ts";
import statementsRouter from "../../routes/statements.ts";
import type { Principal } from "../auth/rbac.ts";
import {
  appFor,
  listen,
  closeAllServers,
} from "../../test-helpers/route-harness.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";
import { firmPrincipal } from "../../test-helpers/principals.ts";

// Reconciliation debit lane (payables round). Pinned here:
//  - the reconcile pipeline proposes DEBIT lines against unpaid BILLS
//    (buyer-side candidates) and never proposes a credit against a bill;
//  - accepting a bill proposal records the statement_match settlement event
//    WITHOUT any lifecycle transition (bills are drafts for life);
//  - the proposals view names the counterparty per orientation (the SUPPLIER
//    for a bill);
//  - bulk-accept flows through the same branched acceptProposal.

const SALT = makeRunSalt();
const firmId = randomUUID();
const clientParty = randomUUID(); // engaged: the statement's owner, the bills' BUYER
const vendorParty = randomUUID(); // not engaged: the bills' supplier
const buyerParty = randomUUID(); // the receivable's buyer
const userId = randomUUID();

const staff: Principal = firmPrincipal(firmId, { userId: userId, role: "firm_staff" });

const BILL_TOTAL = "129000.00";
const RECV_TOTAL = "500000.00";
let billId: string;
let bill2Id: string;
let recvId: string;
let statementId: string;
let debitLineId: string;

function dateOffset(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Drain the outbox until the given event is terminal (feed.test.ts pattern).
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

before(async () => {
  const db = getDb();
  await db
    .insert(usersTable)
    .values({ id: userId, email: `debit-lane-${SALT}@test.local` })
    .onConflictDoNothing();
  await db.insert(firmsTable).values({ id: firmId, name: `Debit Firm ${SALT}` });
  await db.insert(partiesTable).values([
    { id: clientParty, type: "client_business", legalName: `Debit Client ${SALT}` },
    { id: vendorParty, type: "buyer", legalName: `Debit Vendor Supplies ${SALT}` },
    { id: buyerParty, type: "buyer", legalName: `Debit Buyer ${SALT}` },
  ]);
  await db.insert(engagementsTable).values({
    firmId,
    clientPartyId: clientParty,
    type: "retainer",
    title: `debit lane ${SALT}`,
  });
  // Reconciliation surfaces are flag-gated; enable for this firm only.
  await db
    .insert(featureFlagsTable)
    .values({ key: "reconciliation", enabled: false, releaseTag: "R2" })
    .onConflictDoNothing({ target: featureFlagsTable.key });
  await db
    .insert(featureFlagOverridesTable)
    .values({ flagKey: "reconciliation", firmId, enabled: true })
    .onConflictDoNothing();

  // Two unpaid bills (supplier = vendor, buyer = the engaged client) and one
  // stamped receivable (the credit lane's control candidate).
  billId = randomUUID();
  bill2Id = randomUUID();
  recvId = randomUUID();
  await db.insert(invoicesTable).values([
    {
      id: billId,
      firmId,
      supplierPartyId: vendorParty,
      buyerPartyId: clientParty,
      invoiceNumber: `DBL-BILL-${SALT}`,
      status: "draft",
      issueDate: dateOffset(-6),
      dueDate: dateOffset(8),
      grandTotal: BILL_TOTAL,
    },
    {
      id: bill2Id,
      firmId,
      supplierPartyId: vendorParty,
      buyerPartyId: clientParty,
      invoiceNumber: `DBL-BILL2-${SALT}`,
      status: "draft",
      issueDate: dateOffset(-6),
      dueDate: dateOffset(8),
      grandTotal: "77000.00",
    },
    {
      id: recvId,
      firmId,
      supplierPartyId: clientParty,
      buyerPartyId: buyerParty,
      invoiceNumber: `DBL-RECV-${SALT}`,
      status: "stamped",
      issueDate: dateOffset(-6),
      grandTotal: RECV_TOTAL,
    },
  ]);

  const seeded = await seedStatement([
    // Debit paying the bill: exact amount + bill number + supplier name.
    {
      amount: BILL_TOTAL,
      direction: "debit",
      narration: `NIP TRF DEBIT VENDOR SUPPLIES/DBL-BILL-${SALT}`,
    },
    // Credit at the BILL's exact amount: must never propose against the bill
    // (and cannot reach the receivable — the amount disagrees).
    { amount: BILL_TOTAL, direction: "credit", narration: "TRANSFER RECEIVED" },
    // Credit settling the receivable: the untouched control lane.
    {
      amount: RECV_TOTAL,
      direction: "credit",
      narration: `TRF DEBIT BUYER/DBL-RECV-${SALT}`,
    },
  ]);
  statementId = seeded.statementId;
  debitLineId = seeded.lineIds[0];
});

after(async () => {
  await closeAllServers();
});

test("the reconcile pipeline proposes the debit line against the bill — and credits never reach bills", async () => {
  const proposals = await getDb()
    .select()
    .from(matchProposalsTable)
    .innerJoin(
      bankStatementLinesTable,
      eq(bankStatementLinesTable.id, matchProposalsTable.statementLineId),
    )
    .where(eq(bankStatementLinesTable.statementId, statementId));

  const byLine = new Map<string, string[]>();
  for (const p of proposals) {
    const list = byLine.get(p.bank_statement_lines.id) ?? [];
    list.push(p.match_proposals.invoiceId);
    byLine.set(p.bank_statement_lines.id, list);
  }
  assert.deepEqual(
    byLine.get(debitLineId),
    [billId],
    "the debit line proposes exactly the bill",
  );
  // The bill-amount CREDIT proposes nothing: bills are debit-lane only.
  const creditLines = proposals.filter(
    (p) =>
      p.bank_statement_lines.direction === "credit" &&
      p.match_proposals.invoiceId === billId,
  );
  assert.equal(creditLines.length, 0, "credits never propose against bills");
  // The receivable credit still proposes (the untouched lane).
  assert.ok(
    proposals.some((p) => p.match_proposals.invoiceId === recvId),
    "the receivable control proposal exists",
  );
});

test("the proposals view names the counterparty per orientation", async () => {
  const base = await listen(appFor(staff, statementsRouter));
  const res = await fetch(`${base}/statements/${statementId}/proposals`);
  assert.equal(res.status, 200);
  const view = (await res.json()) as {
    invoiceId: string;
    buyerName: string;
  }[];
  const billRow = view.find((p) => p.invoiceId === billId);
  assert.equal(
    billRow?.buyerName,
    `Debit Vendor Supplies ${SALT}`,
    "a bill proposal displays the SUPPLIER (the narration counterparty)",
  );
  const recvRow = view.find((p) => p.invoiceId === recvId);
  assert.equal(
    recvRow?.buyerName,
    `Debit Buyer ${SALT}`,
    "a receivable proposal displays the buyer, as ever",
  );
});

test("accepting a bill proposal records evidence without any transition", async () => {
  const [proposal] = await getDb()
    .select({ id: matchProposalsTable.id })
    .from(matchProposalsTable)
    .where(
      and(
        eq(matchProposalsTable.statementLineId, debitLineId),
        eq(matchProposalsTable.invoiceId, billId),
      ),
    );
  const result = await acceptProposal(proposal.id, {
    userId,
    role: "firm_staff",
  });
  assert.equal(result.status, "accepted");
  assert.equal(result.invoiceStatus, "draft", "no transition — a bill stays a draft");
  assert.ok(result.settlementEventId);

  const [invoice] = await getDb()
    .select({ status: invoicesTable.status })
    .from(invoicesTable)
    .where(eq(invoicesTable.id, billId));
  assert.equal(invoice.status, "draft");

  const events = await getDb()
    .select()
    .from(settlementEventsTable)
    .where(eq(settlementEventsTable.invoiceId, billId));
  assert.equal(events.length, 1);
  assert.equal(events[0].source, "statement_match");
  assert.equal(events[0].statementLineId, debitLineId);

  // No lifecycle lineage was fabricated for a move that never happened.
  const lifecycle = await getDb()
    .select()
    .from(invoiceLifecycleEventsTable)
    .where(eq(invoiceLifecycleEventsTable.invoiceId, billId));
  assert.equal(lifecycle.length, 0);

  // The paid bill leaves the candidate set: a fresh statement with the same
  // debit proposes nothing for it.
  const rerun = await seedStatement([
    {
      amount: BILL_TOTAL,
      direction: "debit",
      narration: `NIP TRF DEBIT VENDOR SUPPLIES/DBL-BILL-${SALT}`,
    },
  ]);
  const stale = await getDb()
    .select({ id: matchProposalsTable.id })
    .from(matchProposalsTable)
    .where(eq(matchProposalsTable.statementLineId, rerun.lineIds[0]));
  assert.equal(stale.length, 0, "a paid bill is no longer a candidate");
});

test("bulk-accept flows a bill proposal through the branched acceptProposal", async () => {
  // A fresh statement whose debit matches the SECOND bill with reference,
  // name, amount and date all agreeing — comfortably above the 0.85 bar.
  const seeded = await seedStatement([
    {
      amount: "77000.00",
      direction: "debit",
      narration: `NIP TRF DEBIT VENDOR SUPPLIES/DBL-BILL2-${SALT}`,
    },
  ]);
  const outcome = await bulkAcceptProposals(seeded.statementId, {
    userId,
    role: "firm_staff",
  });
  assert.equal(outcome.acceptedCount, 1);
  assert.equal(outcome.failedCount, 0);
  assert.equal(outcome.rows[0].invoiceId, bill2Id);

  const [invoice] = await getDb()
    .select({ status: invoicesTable.status })
    .from(invoicesTable)
    .where(eq(invoicesTable.id, bill2Id));
  assert.equal(invoice.status, "draft", "bulk-accept never transitions a bill");
  const events = await getDb()
    .select()
    .from(settlementEventsTable)
    .where(eq(settlementEventsTable.invoiceId, bill2Id));
  assert.equal(events.length, 1);
  assert.equal(events[0].source, "statement_match");
});
