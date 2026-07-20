import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
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
  firmMoneySummary,
  isChaseEligible,
  listChaseRows,
  projectReceivables,
  rankChaseRows,
  receivableProjections,
  type FirmChaseRow,
  type FirmMoneySummary,
} from "./cashflow.ts";
import { OUTSTANDING } from "./receivables.ts";
import type { BuyerPaymentBehaviour } from "./payment-behaviour.ts";
import { lagosDateString } from "../../lib/lagos-time.ts";
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

// Multi-client fixture for the loop-vs-set firmMoneySummary equivalence test.
const firmMulti = randomUUID();
const clientC1 = randomUUID();
const clientC2 = randomUUID();
const clientC3 = randomUUID();
const buyerBR = randomUUID(); // rhythm-taught buyer (C1's settlements)
const buyerBD = randomUUID(); // due-date buyer
const buyerBT = randomUUID(); // terms buyer
const stmtMulti = randomUUID();
const lateC1Id = randomUUID();
const ovdC2Id = randomUUID();
const termsC3Id = randomUUID();

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

  // --- Multi-client fixture (loop-vs-set equivalence) -----------------------
  await db.insert(firmsTable).values({ id: firmMulti, name: `CF Multi Firm ${SALT}` });
  await db.insert(partiesTable).values([
    { id: clientC1, type: "client_business", legalName: `CF Multi C1 ${SALT}` },
    { id: clientC2, type: "client_business", legalName: `CF Multi C2 ${SALT}` },
    { id: clientC3, type: "client_business", legalName: `CF Multi C3 ${SALT}` },
    { id: buyerBR, type: "buyer", legalName: `CF Multi Rhythm ${SALT}` },
    { id: buyerBD, type: "buyer", legalName: `CF Multi Due ${SALT}` },
    { id: buyerBT, type: "buyer", legalName: `CF Multi Terms ${SALT}` },
  ]);
  await db.insert(bankStatementsTable).values({
    id: stmtMulti,
    firmId: firmMulti,
    clientPartyId: clientC1,
    formatKey: "gtb_csv",
  });
  // Three settled C1 invoices teach a ~10-day rhythm for buyerBR.
  let multiLineNo = 0;
  for (const [issued, paid, n] of [
    [40, 30, 1],
    [30, 20, 2],
    [20, 10, 3],
  ] as const) {
    const invoiceId = randomUUID();
    const lineId = randomUUID();
    await db.insert(invoicesTable).values({
      id: invoiceId,
      firmId: firmMulti,
      supplierPartyId: clientC1,
      buyerPartyId: buyerBR,
      invoiceNumber: `CFM-S${n}-${SALT}`,
      issueDate: daysAgo(issued),
      status: "settled",
      grandTotal: "20000.00",
      subtotal: "18604.65",
      vatTotal: "1395.35",
    });
    await db.insert(bankStatementLinesTable).values({
      id: lineId,
      statementId: stmtMulti,
      lineNo: (multiLineNo += 1),
      valueDate: daysAgo(paid),
      amount: "20000.00",
      direction: "credit",
      parseStatus: "parsed",
      rawLine: `multi-raw-${n}`,
    });
    await db.insert(matchProposalsTable).values({
      firmId: firmMulti,
      statementLineId: lineId,
      invoiceId,
      confidence: "0.9000",
      status: "accepted",
    });
  }
  await db.insert(invoicesTable).values([
    // C1: 20 days beyond the 10-day rhythm, no due date — chase-eligible.
    {
      id: lateC1Id,
      firmId: firmMulti,
      supplierPartyId: clientC1,
      buyerPartyId: buyerBR,
      invoiceNumber: `CFM-LATE1-${SALT}`,
      issueDate: daysAgo(30),
      status: "stamped",
      grandTotal: "80000.00",
      subtotal: "74418.60",
      vatTotal: "5581.40",
    },
    // C1: rhythm projects settlement ~5 days out — the coming week.
    {
      firmId: firmMulti,
      supplierPartyId: clientC1,
      buyerPartyId: buyerBR,
      invoiceNumber: `CFM-WEEK1-${SALT}`,
      issueDate: daysAgo(5),
      status: "submitted",
      grandTotal: "50000.00",
      subtotal: "46511.63",
      vatTotal: "3488.37",
    },
    // C2: due 20 days ago (dueDate basis) — chase-eligible. Same
    // daysBeyondExpected as C1's late row, so the topChase money tie-break
    // is exercised ACROSS clients.
    {
      id: ovdC2Id,
      firmId: firmMulti,
      supplierPartyId: clientC2,
      buyerPartyId: buyerBD,
      invoiceNumber: `CFM-OVD2-${SALT}`,
      issueDate: daysAgo(40),
      dueDate: daysAgo(20),
      status: "stamped",
      grandTotal: "60000.00",
      subtotal: "55813.95",
      vatTotal: "4186.05",
    },
    // C2: due in 3 days — the coming week.
    {
      firmId: firmMulti,
      supplierPartyId: clientC2,
      buyerPartyId: buyerBD,
      invoiceNumber: `CFM-WEEK2-${SALT}`,
      issueDate: daysAgo(10),
      dueDate: daysAgo(-3),
      status: "submitted",
      grandTotal: "45000.00",
      subtotal: "41860.47",
      vatTotal: "3139.53",
    },
    // C2: due in 20 days — beyond the coming week (counted nowhere).
    {
      firmId: firmMulti,
      supplierPartyId: clientC2,
      buyerPartyId: buyerBD,
      invoiceNumber: `CFM-LATER2-${SALT}`,
      issueDate: daysAgo(5),
      dueDate: daysAgo(-20),
      status: "submitted",
      grandTotal: "30000.00",
      subtotal: "27906.98",
      vatTotal: "2093.02",
    },
    // C3: no behaviour, no due date — default 30-day terms, 15 days beyond.
    {
      id: termsC3Id,
      firmId: firmMulti,
      supplierPartyId: clientC3,
      buyerPartyId: buyerBT,
      invoiceNumber: `CFM-TERMS3-${SALT}`,
      issueDate: daysAgo(45),
      status: "stamped",
      grandTotal: "70000.00",
      subtotal: "65116.28",
      vatTotal: "4883.72",
    },
    // C3: a non-NGN row in the coming week — counts are currency-safe and
    // the week total keeps the (pre-existing) blind grand_total sum; the
    // equivalence check pins that neither side treats currency specially.
    {
      firmId: firmMulti,
      supplierPartyId: clientC3,
      buyerPartyId: buyerBT,
      invoiceNumber: `CFM-USD3-${SALT}`,
      issueDate: daysAgo(3),
      dueDate: daysAgo(-2),
      currency: "USD",
      status: "submitted",
      grandTotal: "1000.00",
      subtotal: "930.23",
      vatTotal: "69.77",
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

test("firmMoneySummary rolls the same projections up across clients", async () => {
  const summary = await firmMoneySummary(firmId);
  // The beyond-rhythm invoice is late money and chase-eligible (no due
  // date); the future-due invoice sits 10 days out — week 2, not the coming
  // week — so nothing lands in expectedWeek.
  assert.equal(summary.overdueExpectedCount, 1);
  assert.equal(summary.chaseCount, 1);
  assert.equal(summary.expectedWeekCount, 0);
  assert.equal(summary.topChase.length, 1);
  assert.equal(summary.topChase[0].invoiceId, lateInvoiceId);
  assert.equal(summary.topChase[0].clientName, `CF Client ${SALT}`);
  assert.equal(summary.truncated, false, "one client — nothing shed");

  // Firm isolation is absolute.
  const empty = await firmMoneySummary(randomUUID());
  assert.equal(
    empty.expectedWeekCount + empty.overdueExpectedCount + empty.chaseCount,
    0,
  );
  assert.equal(empty.topChase.length, 0);
});

// Reference implementation of firmMoneySummary as it stood before the
// set-based rewrite: the same top-client query, then the per-client
// receivableProjections loop (two queries per client). The rewrite must be
// byte-identical to this on any fixture.
async function referenceFirmMoneySummary(
  targetFirmId: string,
  now: Date,
): Promise<FirmMoneySummary> {
  const today = lagosDateString(now);
  const clientRows = (
    await getDb().execute<{ supplier_party_id: string; client_name: string }>(
      sql`
        SELECT i.supplier_party_id, p.legal_name AS client_name
        FROM invoices i
        JOIN parties p ON p.id = i.supplier_party_id
        WHERE ${OUTSTANDING} AND i.firm_id = ${targetFirmId}
        GROUP BY 1, 2
        ORDER BY SUM(i.grand_total) DESC
        LIMIT 51
      `,
    )
  ).rows;
  const truncated = clientRows.length > 50;
  const clients = clientRows.slice(0, 50);

  let expectedWeekCount = 0;
  let expectedWeekTotal = 0;
  let overdueExpectedCount = 0;
  let chaseCount = 0;
  const topChase: FirmChaseRow[] = [];
  for (const client of clients) {
    const projections = await receivableProjections(
      targetFirmId,
      client.supplier_party_id,
      now,
    );
    for (const p of projections) {
      if (p.daysBeyondExpected > 0) {
        overdueExpectedCount += 1;
        if (isChaseEligible(p, today)) chaseCount += 1;
      } else if (p.daysBeyondExpected > -7) {
        expectedWeekCount += 1;
        const amount = Number(p.grandTotal);
        if (Number.isFinite(amount)) expectedWeekTotal += amount;
      }
    }
    for (const row of rankChaseRows(projections, today)) {
      topChase.push({ ...row, clientName: client.client_name });
    }
  }
  topChase.sort(
    (a, b) =>
      b.daysBeyondExpected - a.daysBeyondExpected ||
      Number(b.grandTotal) - Number(a.grandTotal),
  );
  return {
    expectedWeekCount,
    expectedWeekTotalNgn: expectedWeekTotal.toFixed(2),
    overdueExpectedCount,
    chaseCount,
    topChase: topChase.slice(0, 8),
    truncated,
  };
}

test("set-based firmMoneySummary is byte-identical to the per-client loop", async () => {
  const now = new Date();
  const setBased = await firmMoneySummary(firmMulti, now);
  const reference = await referenceFirmMoneySummary(firmMulti, now);
  assert.deepStrictEqual(setBased, reference);

  // The fixture exercises every aggregate: all three projection bases, the
  // coming-week window, late money, chase eligibility (due-date gated) and
  // the cross-client topChase money tie-break.
  assert.equal(setBased.truncated, false);
  assert.equal(setBased.overdueExpectedCount, 3);
  assert.equal(setBased.chaseCount, 3);
  assert.equal(setBased.expectedWeekCount, 3);
  assert.equal(setBased.expectedWeekTotalNgn, "96000.00");
  assert.deepEqual(
    setBased.topChase.map((r) => r.invoiceId),
    [lateC1Id, ovdC2Id, termsC3Id],
    "equal days beyond expectation ranks by money, across clients",
  );
  assert.deepEqual(
    setBased.topChase.map((r) => r.basis),
    ["rhythm", "dueDate", "terms"],
  );
  assert.equal(setBased.topChase[0].clientName, `CF Multi C1 ${SALT}`);

  // Equivalence holds for the other fixture firm and for an empty firm too.
  const otherNow = new Date();
  assert.deepStrictEqual(
    await firmMoneySummary(firmId, otherNow),
    await referenceFirmMoneySummary(firmId, otherNow),
  );
  const missing = randomUUID();
  assert.deepStrictEqual(
    await firmMoneySummary(missing, otherNow),
    await referenceFirmMoneySummary(missing, otherNow),
  );
});
