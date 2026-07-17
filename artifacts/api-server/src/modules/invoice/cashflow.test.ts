import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  getDb,
  firmsTable,
  partiesTable,
  invoicesTable,
  bankStatementsTable,
  bankStatementLinesTable,
  matchProposalsTable,
} from "@workspace/db";
import {
  bucketProjections,
  computeCashflowOutlook,
  listChaseRows,
  projectReceivables,
  rankChaseRows,
} from "./cashflow.ts";
import type { BuyerPaymentBehaviour } from "./payment-behaviour.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Cash-flow outlook + chase list (round-10 ideas #1/#2). Pinned invariants:
//  - projection basis is rhythm > due date > default terms, per buyer;
//  - money past its expected date is its own bucket, never future inflow;
//  - the chase list contains ONLY invoices past expectation, most beyond
//  first, money as tie-break, capped;
//  - both surfaces share one projection, so they can never disagree.

const SALT = makeRunSalt();
const firmId = randomUUID();
const clientId = randomUUID();
const buyerRhythm = randomUUID();
const buyerDue = randomUUID();
const statementId = randomUUID();
const lateInvoiceId = randomUUID();

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

const behaviour = (
  buyerPartyId: string,
  medianDaysToPay: number,
): BuyerPaymentBehaviour => ({
  buyerPartyId,
  buyerName: "B",
  settledCount: 3,
  medianDaysToPay,
  lastSettledDate: "2026-01-01",
});

test("projectReceivables picks rhythm > dueDate > terms", () => {
  const row = (over: {
    buyerPartyId: string;
    issueDate: string;
    dueDate?: string | null;
  }) => ({
    invoiceId: randomUUID(),
    invoiceNumber: "N",
    buyerName: "B",
    currency: "NGN",
    grandTotal: "100.00",
    dueDate: null,
    ...over,
  });
  const projections = projectReceivables(
    [
      row({ buyerPartyId: "rhythm", issueDate: "2026-06-01", dueDate: "2026-07-20" }),
      row({ buyerPartyId: "due", issueDate: "2026-06-01", dueDate: "2026-06-20" }),
      row({ buyerPartyId: "bare", issueDate: "2026-06-01" }),
    ],
    new Map([["rhythm", behaviour("rhythm", 14)]]),
    "2026-06-25",
  );
  // Rhythm outranks the stated due date.
  assert.equal(projections[0].basis, "rhythm");
  assert.equal(projections[0].expectedDate, "2026-06-15");
  assert.equal(projections[0].daysBeyondExpected, 10);
  assert.equal(projections[1].basis, "dueDate");
  assert.equal(projections[1].expectedDate, "2026-06-20");
  assert.equal(projections[1].daysBeyondExpected, 5);
  // No behaviour, no due date: default 30-day terms.
  assert.equal(projections[2].basis, "terms");
  assert.equal(projections[2].expectedDate, "2026-07-01");
  assert.equal(projections[2].daysBeyondExpected, -6);
});

test("bucketProjections and rankChaseRows split late from future", () => {
  const proj = (over: {
    daysBeyondExpected: number;
    grandTotal?: string;
    currency?: string;
  }) => ({
    invoiceId: randomUUID(),
    invoiceNumber: "N",
    buyerPartyId: "b",
    buyerName: "B",
    currency: over.currency ?? "NGN",
    grandTotal: over.grandTotal ?? "100.00",
    issueDate: "2026-06-01",
    dueDate: null,
    expectedDate: "2026-06-15",
    basis: "terms" as const,
    daysBeyondExpected: over.daysBeyondExpected,
  });
  const groups = bucketProjections(
    [
      proj({ daysBeyondExpected: 5 }), // late
      proj({ daysBeyondExpected: 0 }), // expected today → this week
      proj({ daysBeyondExpected: -8 }), // next week
      proj({ daysBeyondExpected: -30 }), // beyond the four weeks
    ],
    "2026-06-25",
  );
  assert.equal(groups.length, 1);
  const g = groups[0];
  assert.equal(g.overdueExpected.count, 1);
  assert.equal(g.weeks[0].count, 1);
  assert.equal(g.weeks[0].startDate, "2026-06-25");
  assert.equal(g.weeks[1].count, 1);
  assert.equal(g.later.count, 1);
  assert.equal(g.total.count, 4);
  assert.equal(g.total.amount, "400.00");

  // Chase list: only past-expectation rows, most beyond first, money breaks
  // ties, capped.
  const ranked = rankChaseRows(
    [
      proj({ daysBeyondExpected: 3 }),
      proj({ daysBeyondExpected: 9 }),
      proj({ daysBeyondExpected: 9, grandTotal: "900.00" }),
      proj({ daysBeyondExpected: -2 }),
    ],
    "2026-06-25",
  );
  assert.equal(ranked.length, 3);
  assert.equal(ranked[0].grandTotal, "900.00");
  assert.equal(ranked[1].daysBeyondExpected, 9);
  assert.equal(ranked[2].daysBeyondExpected, 3);

  // An invoice beyond the buyer's rhythm but NOT yet contractually due must
  // never be chased — the due date gates, whatever the rhythm says.
  const notYetDue = {
    ...proj({ daysBeyondExpected: 11 }),
    basis: "rhythm" as const,
    dueDate: "2026-07-30",
  };
  assert.equal(rankChaseRows([notYetDue], "2026-06-25").length, 0);
  // Past BOTH dates: chased.
  assert.equal(
    rankChaseRows([{ ...notYetDue, dueDate: "2026-06-20" }], "2026-06-25")
      .length,
    1,
  );
});

before(async () => {
  const db = getDb();
  await db.insert(firmsTable).values({ id: firmId, name: `CF Firm ${SALT}` });
  await db.insert(partiesTable).values([
    { id: clientId, type: "client_business", legalName: `CF Client ${SALT}` },
    { id: buyerRhythm, type: "buyer", legalName: `CF Rhythm Buyer ${SALT}` },
    { id: buyerDue, type: "buyer", legalName: `CF Due Buyer ${SALT}` },
  ]);
  await db.insert(bankStatementsTable).values({
    id: statementId,
    firmId,
    clientPartyId: clientId,
    formatKey: "gtb_csv",
  });
  // Three settled invoices teach a ~15-day rhythm for buyerRhythm.
  let lineNo = 0;
  for (const [issued, paid, n] of [
    [90, 75, 1],
    [60, 45, 2],
    [30, 15, 3],
  ] as const) {
    const invoiceId = randomUUID();
    const lineId = randomUUID();
    await db.insert(invoicesTable).values({
      id: invoiceId,
      firmId,
      supplierPartyId: clientId,
      buyerPartyId: buyerRhythm,
      invoiceNumber: `CF-S${n}-${SALT}`,
      issueDate: daysAgo(issued),
      status: "settled",
      grandTotal: "50000.00",
      subtotal: "46511.63",
      vatTotal: "3488.37",
    });
    await db.insert(bankStatementLinesTable).values({
      id: lineId,
      statementId,
      lineNo: (lineNo += 1),
      valueDate: daysAgo(paid),
      amount: "50000.00",
      direction: "credit",
      parseStatus: "parsed",
      rawLine: `raw-${n}`,
    });
    await db.insert(matchProposalsTable).values({
      firmId,
      statementLineId: lineId,
      invoiceId,
      confidence: "0.9000",
      status: "accepted",
    });
  }
  await db.insert(invoicesTable).values([
    // Outstanding, issued 40 days ago → ~25 days beyond the 15-day rhythm.
    {
      id: lateInvoiceId,
      firmId,
      supplierPartyId: clientId,
      buyerPartyId: buyerRhythm,
      invoiceNumber: `CF-LATE-${SALT}`,
      issueDate: daysAgo(40),
      status: "stamped",
      grandTotal: "80000.00",
      subtotal: "74418.60",
      vatTotal: "5581.40",
    },
    // Outstanding with a future due date and no behaviour: future inflow.
    {
      firmId,
      supplierPartyId: clientId,
      buyerPartyId: buyerDue,
      invoiceNumber: `CF-FUT-${SALT}`,
      issueDate: daysAgo(5),
      dueDate: daysAgo(-10),
      status: "submitted",
      grandTotal: "30000.00",
      subtotal: "27906.98",
      vatTotal: "2093.02",
    },
  ]);
});

test("outlook and chase list agree end to end", async () => {
  const outlook = await computeCashflowOutlook(firmId, clientId);
  assert.equal(outlook.groups.length, 1);
  const g = outlook.groups[0];
  assert.equal(g.total.count, 2, "settled invoices are not receivables");
  assert.equal(g.overdueExpected.count, 1, "the beyond-rhythm invoice");
  assert.equal(g.overdueExpected.amount, "80000.00");
  const future = g.weeks.reduce((s, w) => s + w.count, 0) + g.later.count;
  assert.equal(future, 1, "the future-due invoice");

  const chase = await listChaseRows(firmId, clientId);
  assert.equal(chase.length, 1, "only past-expectation invoices are chased");
  assert.equal(chase[0].invoiceId, lateInvoiceId);
  assert.equal(chase[0].basis, "rhythm");
  assert.ok(
    chase[0].daysBeyondExpected >= 24 && chase[0].daysBeyondExpected <= 26,
    `beyond rhythm by ~25 days, got ${chase[0].daysBeyondExpected}`,
  );

  // Tenancy mirrors every miner.
  assert.equal((await listChaseRows(randomUUID(), clientId)).length, 0);
  assert.equal(
    (await computeCashflowOutlook(firmId, randomUUID())).groups.length,
    0,
  );
});
