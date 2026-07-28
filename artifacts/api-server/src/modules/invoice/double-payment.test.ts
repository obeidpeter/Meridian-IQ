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
//  - a bill carrying TWO independent payment evidences (payer flag + a
//    statement match) is flagged as multi-paid, with the evidence span;
//  - one payment evidence alone is NOT multi-paid;
//  - unpaid bills from the same supplier for the same amount issued within
//    the near-duplicate window pair up exactly once; a paid sibling and a
//    far-apart sibling never pair;
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

  // Paid twice: a payer flag AND a statement match.
  paidTwiceId = await seedBill({
    buyerPartyId: clientParty,
    invoiceNumber: `DP-TWICE-${SALT}`,
    grandTotal: "900.00",
    issueDate: "2026-07-01",
  });
  await db.insert(settlementEventsTable).values([
    {
      invoiceId: paidTwiceId,
      source: "payer_flag",
      amount: "900.00",
      paymentStatus: "paid",
      occurredAt: new Date("2026-07-05T09:00:00Z"),
    },
    {
      invoiceId: paidTwiceId,
      source: "statement_match",
      amount: "900.00",
      occurredAt: new Date("2026-07-09T09:00:00Z"),
    },
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
  // Same total inside the window but PAID: payment evidence removes it from
  // the duplicate lane (one evidence — not multi-paid either).
  const paidDup = await seedBill({
    buyerPartyId: clientParty,
    invoiceNumber: `DP-PAIDDUP-${SALT}`,
    grandTotal: "500.00",
    issueDate: "2026-07-12",
  });
  await db.insert(settlementEventsTable).values({
    invoiceId: paidDup,
    source: "payer_flag",
    amount: "500.00",
    paymentStatus: "paid",
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

test("two payment evidences flag a bill as multi-paid; one does not", async () => {
  const check = await computeDoublePaymentCheck(firmId, clientParty);
  assert.equal(check.multiPaid.length, 1);
  const hit = check.multiPaid[0];
  assert.equal(hit.invoiceId, paidTwiceId);
  assert.equal(hit.evidenceCount, 2);
  assert.equal(hit.firstPaidAt, "2026-07-05T09:00:00.000Z");
  assert.equal(hit.lastPaidAt, "2026-07-09T09:00:00.000Z");
  assert.match(check.note, /Advisory only/);
});

test("unpaid same-supplier same-amount bills pair once inside the window", async () => {
  const check = await computeDoublePaymentCheck(firmId, clientParty);
  assert.equal(check.duplicateCandidates.length, 1);
  const pair = check.duplicateCandidates[0];
  assert.deepEqual(
    [pair.first.invoiceId, pair.second.invoiceId].sort(),
    [dupAId, dupBId].sort(),
    "the far, paid and sibling bills never pair",
  );
  assert.equal(pair.daysApart, 5);
  assert.equal(pair.grandTotal, "500.00");
});

test("the sibling client's view is empty — scope is per client", async () => {
  const check = await computeDoublePaymentCheck(firmId, siblingParty);
  assert.equal(check.multiPaid.length, 0);
  assert.equal(check.duplicateCandidates.length, 0);
});
