import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  getDb,
  engagementsTable,
  firmsTable,
  invoicesTable,
  partiesTable,
  settlementEventsTable,
} from "@workspace/db";
import { computeDoublePaymentCheck } from "./double-payment.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Double-payment guard (round-16 idea #3). Pinned here:
//  - "paid twice" means TWO DISTINCT bank debits totalling MORE than the
//    bill: a payer flag plus its confirming statement match (the ordinary
//    lifecycle) never flags, and two partial matches summing to the total
//    (installments) never flag;
//  - near-duplicate pairs: same supplier, same amount, within the window,
//    second side unpaid — both-unpaid pairs appear once, and a PAID
//    original next to its unpaid copy is reported as pairKind
//    "paid_original" (the riskiest shape); a far-apart sibling never pairs;
//  - the check is client-scoped: a sibling client's identical bill does not
//    appear (SEC-03 through BILL_OF_CLIENT);
//  - the note pins the advisory posture.

const SALT = makeRunSalt();
const firmId = randomUUID();
const clientParty = randomUUID(); // the bills' buyer
const siblingParty = randomUUID(); // engaged sibling — isolation probe
const vendorParty = randomUUID(); // the bills' supplier (not engaged)

let paidTwiceId: string;
let dupAId: string;
let dupBId: string;
let paidDupId: string;

async function seedBill(input: {
  buyerPartyId: string;
  invoiceNumber: string;
  grandTotal: string;
  issueDate: string;
}): Promise<string> {
  const id = randomUUID();
  await getDb().insert(invoicesTable).values({
    id,
    firmId,
    supplierPartyId: vendorParty,
    buyerPartyId: input.buyerPartyId,
    invoiceNumber: input.invoiceNumber,
    status: "draft",
    issueDate: input.issueDate,
    grandTotal: input.grandTotal,
    subtotal: input.grandTotal,
    vatTotal: "0.00",
  });
  return id;
}

function statementMatch(
  invoiceId: string,
  amount: string,
  occurredAt: string,
) {
  return {
    invoiceId,
    source: "statement_match" as const,
    statementLineId: randomUUID(),
    amount,
    occurredAt: new Date(occurredAt),
  };
}

before(async () => {
  const db = getDb();
  await db.insert(firmsTable).values({ id: firmId, name: `DP Firm ${SALT}` });
  await db.insert(partiesTable).values([
    { id: clientParty, type: "client_business", legalName: `DP Client ${SALT}` },
    { id: siblingParty, type: "client_business", legalName: `DP Sibling ${SALT}` },
    { id: vendorParty, type: "buyer", legalName: `DP Vendor ${SALT}` },
  ]);
  await db.insert(engagementsTable).values([
    { firmId, clientPartyId: clientParty, type: "retainer", title: `dp A ${SALT}` },
    { firmId, clientPartyId: siblingParty, type: "retainer", title: `dp B ${SALT}` },
  ]);

  // Paid twice: two DISTINCT statement-line debits, 2× the bill.
  paidTwiceId = await seedBill({
    buyerPartyId: clientParty,
    invoiceNumber: `DP-TWICE-${SALT}`,
    grandTotal: "900.00",
    issueDate: "2026-07-01",
  });
  await db
    .insert(settlementEventsTable)
    .values([
      statementMatch(paidTwiceId, "900.00", "2026-07-05T09:00:00Z"),
      statementMatch(paidTwiceId, "900.00", "2026-07-09T09:00:00Z"),
    ]);

  // The ORDINARY lifecycle: a payer flag then its confirming statement
  // match — one payment, never "paid twice".
  const ordinary = await seedBill({
    buyerPartyId: clientParty,
    invoiceNumber: `DP-ORDINARY-${SALT}`,
    grandTotal: "700.00",
    issueDate: "2026-06-20",
  });
  await db.insert(settlementEventsTable).values([
    {
      invoiceId: ordinary,
      source: "payer_flag",
      amount: "700.00",
      paymentStatus: "paid",
      occurredAt: new Date("2026-06-25T09:00:00Z"),
    },
    statementMatch(ordinary, "700.00", "2026-06-27T09:00:00Z"),
  ]);

  // Installments: two partial debits summing EXACTLY to the bill.
  const installments = await seedBill({
    buyerPartyId: clientParty,
    invoiceNumber: `DP-INSTAL-${SALT}`,
    grandTotal: "600.00",
    issueDate: "2026-06-10",
  });
  await db
    .insert(settlementEventsTable)
    .values([
      statementMatch(installments, "300.00", "2026-06-15T09:00:00Z"),
      statementMatch(installments, "300.00", "2026-06-29T09:00:00Z"),
    ]);

  // The near-duplicate pair: same supplier, same total, 5 days apart, unpaid.
  dupAId = await seedBill({
    buyerPartyId: clientParty,
    invoiceNumber: `DP-DUP-A-${SALT}`,
    grandTotal: "500.00",
    issueDate: "2026-07-10",
  });
  dupBId = await seedBill({
    buyerPartyId: clientParty,
    invoiceNumber: `DP-DUP-B-${SALT}`,
    grandTotal: "500.00",
    issueDate: "2026-07-15",
  });
  // Same total but far outside the window: never pairs.
  await seedBill({
    buyerPartyId: clientParty,
    invoiceNumber: `DP-FAR-${SALT}`,
    grandTotal: "500.00",
    issueDate: "2026-05-01",
  });
  // Same total inside the window and already PAID: the riskiest shape — a
  // paid original next to unpaid copies — reported as pairKind
  // "paid_original" with the paid bill in the first seat.
  paidDupId = await seedBill({
    buyerPartyId: clientParty,
    invoiceNumber: `DP-PAIDDUP-${SALT}`,
    grandTotal: "500.00",
    issueDate: "2026-07-12",
  });
  await db.insert(settlementEventsTable).values({
    invoiceId: paidDupId,
    source: "payer_flag",
    amount: "500.00",
    paymentStatus: "paid",
    actorId: null,
    occurredAt: new Date("2026-07-13T09:00:00Z"),
  });
  // The sibling client's identical bill: out of scope.
  await seedBill({
    buyerPartyId: siblingParty,
    invoiceNumber: `DP-SIB-${SALT}`,
    grandTotal: "500.00",
    issueDate: "2026-07-11",
  });
});

test("only distinct over-total bank debits flag a bill as paid twice", async () => {
  const check = await computeDoublePaymentCheck(firmId, clientParty);
  assert.equal(check.multiPaid.length, 1, "flag+match and installments never flag");
  const hit = check.multiPaid[0];
  assert.equal(hit.invoiceId, paidTwiceId);
  assert.equal(hit.evidenceCount, 2);
  assert.equal(hit.firstPaidAt, "2026-07-05T09:00:00.000Z");
  assert.equal(hit.lastPaidAt, "2026-07-09T09:00:00.000Z");
  assert.match(check.note, /Advisory only/);
});

test("duplicate pairs: both-unpaid once, paid original against each unpaid copy", async () => {
  const check = await computeDoublePaymentCheck(firmId, clientParty);
  const bothUnpaid = check.duplicateCandidates.filter(
    (p) => p.pairKind === "both_unpaid",
  );
  assert.equal(bothUnpaid.length, 1);
  assert.deepEqual(
    [bothUnpaid[0].first.invoiceId, bothUnpaid[0].second.invoiceId].sort(),
    [dupAId, dupBId].sort(),
    "the far and sibling bills never pair",
  );
  assert.equal(bothUnpaid[0].daysApart, 5);
  const paidOriginal = check.duplicateCandidates.filter(
    (p) => p.pairKind === "paid_original",
  );
  assert.equal(paidOriginal.length, 2, "the paid bill pairs with each unpaid copy");
  for (const pair of paidOriginal) {
    assert.equal(pair.first.invoiceId, paidDupId, "the paid side takes the first seat");
    assert.ok([dupAId, dupBId].includes(pair.second.invoiceId));
  }
});

test("the sibling client's view is empty — scope is per client", async () => {
  const check = await computeDoublePaymentCheck(firmId, siblingParty);
  assert.equal(check.multiPaid.length, 0);
  assert.equal(check.duplicateCandidates.length, 0);
});
