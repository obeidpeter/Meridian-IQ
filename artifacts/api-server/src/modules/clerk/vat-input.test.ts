import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  getDb,
  firmsTable,
  partiesTable,
  invoicesTable,
  engagementsTable,
  submissionAttemptsTable,
  billVerificationsTable,
} from "@workspace/db";
import { closedLagosMonths } from "./vat-pack.ts";
import { computeVatPosition } from "./vat-input.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Net VAT position (round-15 idea #1). Pinned invariants:
//  - the input side is the firm's BILLS issued in the month (bill
//    orientation: buyer engaged, supplier not) — a receivable invoice never
//    counts as input VAT, whatever its month;
//  - input VAT moves into the position ONLY when the bill's newest stamp
//    verification says valid; an older valid verdict superseded by an
//    invalid one does not count;
//  - the output side is computeVatPack's totals verbatim, and the position
//    is outputNet − verifiedInput;
//  - unverified bills come back largest VAT first as the CTA.
// The seeded firm is unique to this test, so its numbers are exact.

const SALT = makeRunSalt();
const firmId = randomUUID();
const clientId = randomUUID();
const vendorId = randomUUID();
const buyerId = randomUUID();
const userId = randomUUID();
const monthStart = closedLagosMonths()[0];
const inMonth = (day: number) =>
  `${monthStart.slice(0, 8)}${String(day).padStart(2, "0")}`;

before(async () => {
  const db = getDb();
  await db.insert(firmsTable).values({ id: firmId, name: `VP Firm ${SALT}` });
  await db.insert(partiesTable).values([
    { id: clientId, type: "client_business", legalName: `VP Client ${SALT}` },
    { id: vendorId, type: "buyer", legalName: `VP Vendor ${SALT}` },
    { id: buyerId, type: "buyer", legalName: `VP Buyer ${SALT}` },
  ]);
  // The client is engaged (defines both orientations: bills have the client
  // as BUYER; receivables have it as SUPPLIER).
  await db.insert(engagementsTable).values({
    firmId,
    clientPartyId: clientId,
    type: "retainer",
    title: `VP engagement ${SALT}`,
  });

  const mkInvoice = async (
    n: string,
    supplier: string,
    buyer: string,
    issueDate: string,
    vat: string,
    status = "draft",
  ) => {
    const id = randomUUID();
    await db.insert(invoicesTable).values({
      id,
      firmId,
      supplierPartyId: supplier,
      buyerPartyId: buyer,
      invoiceNumber: n,
      issueDate,
      status: status as never,
      grandTotal: "1000.00",
      vatTotal: vat,
    });
    return id;
  };
  const verify = async (invoiceId: string, valid: boolean, agoDays: number) => {
    await db.insert(billVerificationsTable).values({
      firmId,
      invoiceId,
      irn: `IRN-${SALT}`,
      csid: `CSID-${SALT}`,
      valid,
      eligible: valid ? true : null,
      checkedByUserId: userId,
      checkedAt: new Date(Date.now() - agoDays * 86_400_000),
    });
  };

  // Verified bill: 75.00 input VAT counts.
  const verified = await mkInvoice(
    `VP-B1-${SALT}`,
    vendorId,
    clientId,
    inMonth(5),
    "75.00",
  );
  await verify(verified, true, 2);
  // Newest verification says INVALID (an older valid one is superseded).
  const flipped = await mkInvoice(
    `VP-B2-${SALT}`,
    vendorId,
    clientId,
    inMonth(8),
    "40.00",
  );
  await verify(flipped, true, 5);
  await verify(flipped, false, 1);
  // Never verified: 60.00 unverified.
  await mkInvoice(`VP-B3-${SALT}`, vendorId, clientId, inMonth(12), "60.00");
  // Out of month: excluded entirely.
  const prev = new Date(`${monthStart}T12:00:00Z`);
  prev.setUTCDate(0);
  await mkInvoice(
    `VP-B4-${SALT}`,
    vendorId,
    clientId,
    prev.toISOString().slice(0, 10),
    "99.00",
  );
  // Receivable in the same month (client is SUPPLIER), rails-accepted:
  // output side only — 150.00 output VAT, never input.
  const receivable = await mkInvoice(
    `VP-R1-${SALT}`,
    clientId,
    buyerId,
    inMonth(10),
    "150.00",
    "settled",
  );
  await db.insert(submissionAttemptsTable).values({
    invoiceId: receivable,
    rail: "rail_primary",
    attemptNo: 1,
    idempotencyKey: `vp-${receivable}-1`,
    status: "accepted" as never,
  });
});

test("output, verified input and the net position partition exactly", async () => {
  const position = await computeVatPosition(firmId, monthStart);

  assert.equal(position.outputNetVat, "150.00");
  assert.equal(position.billCount, 3, "in-month bills only");
  assert.equal(position.billVat, "175.00");
  assert.equal(position.verifiedCount, 1, "newest-verdict wins");
  assert.equal(position.verifiedVat, "75.00");
  assert.equal(position.unverifiedCount, 2);
  assert.equal(position.unverifiedVat, "100.00");
  assert.equal(position.netPosition, "75.00", "150 output − 75 verified");

  // CTA: largest unverified VAT first; the flipped bill counts as
  // unverified because its NEWEST verdict is invalid.
  assert.equal(position.unverified.length, 2);
  assert.equal(position.unverified[0].vatTotal, "60.00");
  assert.equal(position.unverified[1].vatTotal, "40.00");
  assert.equal(position.unverifiedTruncated, false);
  assert.match(position.note, /recovery opportunity/);
  assert.ok(position.months.includes(monthStart));
});

test("another firm sees zeros", async () => {
  const other = randomUUID();
  await getDb()
    .insert(firmsTable)
    .values({ id: other, name: `VP Other ${SALT}` });
  const position = await computeVatPosition(other, monthStart);
  assert.equal(position.billCount, 0);
  assert.equal(position.netPosition, "0.00");
  assert.equal(position.unverified.length, 0);
});
