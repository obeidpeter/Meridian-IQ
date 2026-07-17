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
  listPaymentBehaviour,
  summarizeBehaviour,
} from "./payment-behaviour.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Buyer payment-behaviour memory (round-9 idea #1). Pinned invariants:
//  - evidence is ONLY accepted proposals over credit lines with a value
//  date — the human-confirmed exhaust, never the matcher's guesses;
//  - fewer than three settlements is an anecdote, not behaviour;
//  - a credit dated before its invoice is never latency evidence;
//  - tenancy mirrors the other miners (firm + client party).

const SALT = makeRunSalt();
const firmId = randomUUID();
const clientId = randomUUID();
const buyerSteady = randomUUID();
const buyerThin = randomUUID();
const statementId = randomUUID();

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

before(async () => {
  const db = getDb();
  await db.insert(firmsTable).values({ id: firmId, name: `PB Firm ${SALT}` });
  await db.insert(partiesTable).values([
    { id: clientId, type: "client_business", legalName: `PB Client ${SALT}` },
    { id: buyerSteady, type: "buyer", legalName: `PB Steady Buyer ${SALT}` },
    { id: buyerThin, type: "buyer", legalName: `PB Thin Buyer ${SALT}` },
  ]);
  await db.insert(bankStatementsTable).values({
    id: statementId,
    firmId,
    clientPartyId: clientId,
    formatKey: "gtb_csv",
  });

  // Three settled invoices for the steady buyer (~18 days to pay each), one
  // for the thin buyer, plus decoys: a proposed-only match, a debit line and
  // a credit dated before its invoice.
  let lineNo = 0;
  const mk = async (over: {
    buyer: string;
    number: string;
    issued: number; // days ago
    paid: number | null; // days ago; null = no matched line
    status?: "proposed" | "accepted";
    direction?: "credit" | "debit";
  }) => {
    const invoiceId = randomUUID();
    await getDb().insert(invoicesTable).values({
      id: invoiceId,
      firmId,
      supplierPartyId: clientId,
      buyerPartyId: over.buyer,
      invoiceNumber: over.number,
      issueDate: daysAgo(over.issued),
      status: over.paid !== null ? "settled" : "confirmed",
      grandTotal: "100000.00",
      subtotal: "93023.26",
      vatTotal: "6976.74",
    });
    if (over.paid === null) return;
    const lineId = randomUUID();
    await getDb().insert(bankStatementLinesTable).values({
      id: lineId,
      statementId,
      lineNo: (lineNo += 1),
      valueDate: daysAgo(over.paid),
      amount: "100000.00",
      direction: over.direction ?? "credit",
      parseStatus: "parsed",
      rawLine: `raw-${over.number}`,
    });
    await getDb().insert(matchProposalsTable).values({
      firmId,
      statementLineId: lineId,
      invoiceId,
      confidence: "0.9000",
      status: over.status ?? "accepted",
    });
  };

  await mk({ buyer: buyerSteady, number: `PB-S1-${SALT}`, issued: 100, paid: 82 });
  await mk({ buyer: buyerSteady, number: `PB-S2-${SALT}`, issued: 70, paid: 52 });
  await mk({ buyer: buyerSteady, number: `PB-S3-${SALT}`, issued: 40, paid: 20 });
  // Decoys that must not count:
  await mk({ buyer: buyerSteady, number: `PB-SP-${SALT}`, issued: 30, paid: 10, status: "proposed" });
  await mk({ buyer: buyerSteady, number: `PB-SD-${SALT}`, issued: 30, paid: 10, direction: "debit" });
  await mk({ buyer: buyerSteady, number: `PB-SN-${SALT}`, issued: 10, paid: 20 }); // paid before issue
  // Thin buyer: real settlements but below the sample floor.
  await mk({ buyer: buyerThin, number: `PB-T1-${SALT}`, issued: 60, paid: 50 });
  await mk({ buyer: buyerThin, number: `PB-T2-${SALT}`, issued: 30, paid: 20 });
});

test("summarizeBehaviour is pure and conservative", () => {
  const row = (buyer: string, days: number, valueDate: string) => ({
    buyerPartyId: buyer,
    buyerName: "B",
    daysToPay: days,
    valueDate,
  });
  // Median over three observations, newest settlement date wins.
  const out = summarizeBehaviour([
    row("b1", 10, "2026-01-10"),
    row("b1", 20, "2026-03-10"),
    row("b1", 18, "2026-02-10"),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].medianDaysToPay, 18);
  assert.equal(out[0].settledCount, 3);
  assert.equal(out[0].lastSettledDate, "2026-03-10");

  // Two observations: silence. Negatives dropped before the floor check.
  assert.equal(summarizeBehaviour([row("b1", 10, "2026-01-10"), row("b1", 12, "2026-01-11")]).length, 0);
  assert.equal(
    summarizeBehaviour([
      row("b1", -5, "2026-01-10"),
      row("b1", 10, "2026-01-11"),
      row("b1", 12, "2026-01-12"),
    ]).length,
    0,
  );
});

test("listPaymentBehaviour mines only accepted credit matches", async () => {
  const behaviour = await listPaymentBehaviour(firmId, clientId);
  assert.equal(behaviour.length, 1, "steady buyer only — thin stays silent");
  const b = behaviour[0];
  assert.equal(b.buyerPartyId, buyerSteady);
  assert.equal(b.buyerName, `PB Steady Buyer ${SALT}`);
  assert.equal(b.settledCount, 3, "proposed/debit/negative decoys excluded");
  assert.equal(b.medianDaysToPay, 18);
  assert.equal(b.lastSettledDate, daysAgo(20));
});

test("another firm or another client sees nothing", async () => {
  assert.equal((await listPaymentBehaviour(randomUUID(), clientId)).length, 0);
  assert.equal((await listPaymentBehaviour(firmId, randomUUID())).length, 0);
});
