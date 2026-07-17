import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  getDb,
  firmsTable,
  partiesTable,
  invoicesTable,
  submissionAttemptsTable,
} from "@workspace/db";
import { closedLagosMonths } from "./vat-pack.ts";
import { computeVatSettlementCheck } from "./vat-settlement.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// VAT settlement cross-check (round-13 idea #6). Pinned invariants:
//  - the population is EXACTLY the VAT pack's month membership (issue month,
//    rails-accepted, cancelled excluded, invoices only) — an invoice with no
//    accepted attempt, or issued outside the month, never appears;
//  - settled + outstanding + credited partition the accepted set (an
//    accepted invoice's status is always one of the three);
//  - the outstanding bucket is the receivables OUTSTANDING definition, so
//    the cross-check can never call something unsettled that the
//    receivables page calls closed;
//  - the note discloses "unobserved, not unpaid".
// The seeded firm is unique to this test, so its numbers are exact.

const SALT = makeRunSalt();
const firmId = randomUUID();
const clientId = randomUUID();
const buyerId = randomUUID();
const monthStart = closedLagosMonths()[0];
const inMonth = (day: number) =>
  `${monthStart.slice(0, 8)}${String(day).padStart(2, "0")}`;

let outstandingId: string;

before(async () => {
  const db = getDb();
  await db.insert(firmsTable).values({ id: firmId, name: `VS Firm ${SALT}` });
  await db.insert(partiesTable).values([
    { id: clientId, type: "client_business", legalName: `VS Client ${SALT}` },
    { id: buyerId, type: "buyer", legalName: `VS Buyer ${SALT}` },
  ]);

  const mkInvoice = async (
    n: string,
    issueDate: string,
    status: string,
    grand: string,
    accepted: boolean,
  ) => {
    const id = randomUUID();
    await db.insert(invoicesTable).values({
      id,
      firmId,
      supplierPartyId: clientId,
      buyerPartyId: buyerId,
      invoiceNumber: n,
      issueDate,
      status: status as never,
      grandTotal: grand,
      vatTotal: "0.00",
    });
    if (accepted) {
      await db.insert(submissionAttemptsTable).values({
        invoiceId: id,
        rail: "rail_primary",
        attemptNo: 1,
        idempotencyKey: `vs-${id}-1`,
        status: "accepted" as never,
      });
    }
    return id;
  };

  // The accepted set: settled 1000 + outstanding 500 + credited 250.
  await mkInvoice(`VS-S-${SALT}`, inMonth(5), "settled", "1000.00", true);
  outstandingId = await mkInvoice(
    `VS-O-${SALT}`,
    inMonth(10),
    "confirmed",
    "500.00",
    true,
  );
  await mkInvoice(`VS-C-${SALT}`, inMonth(15), "credited", "250.00", true);
  // Never accepted: not part of the pack month, whatever its value.
  await mkInvoice(`VS-X-${SALT}`, inMonth(20), "submitted", "9000.00", false);
  // Accepted but issued the month before: the pack's issue basis excludes it.
  const prev = new Date(`${monthStart}T12:00:00Z`);
  prev.setUTCDate(0); // last day of the previous month
  await mkInvoice(
    `VS-P-${SALT}`,
    prev.toISOString().slice(0, 10),
    "settled",
    "700.00",
    true,
  );
});

test("the cross-check partitions the pack month's accepted value exactly", async () => {
  const check = await computeVatSettlementCheck(firmId, monthStart);

  assert.equal(check.acceptedCount, 3);
  assert.equal(check.acceptedTotal, "1750.00");
  assert.equal(check.settledCount, 1);
  assert.equal(check.settledTotal, "1000.00");
  assert.equal(check.outstandingCount, 1);
  assert.equal(check.outstandingTotal, "500.00");
  assert.equal(check.creditedCount, 1);
  assert.equal(check.creditedTotal, "250.00");
  // The three buckets partition the accepted set.
  assert.equal(
    check.settledCount + check.outstandingCount + check.creditedCount,
    check.acceptedCount,
  );
  assert.equal(check.settledShare, 0.5714);

  assert.equal(check.unsettled.length, 1);
  assert.equal(check.unsettled[0].invoiceId, outstandingId);
  assert.equal(check.unsettled[0].grandTotal, "500.00");
  assert.equal(check.unsettled[0].buyerName, `VS Buyer ${SALT}`);
  assert.equal(check.unsettledTruncated, false);

  assert.ok(check.months.includes(monthStart));
  assert.match(check.note, /UNOBSERVED, not necessarily unpaid/);
});

test("an empty month answers with zeros and a null share, never NaN", async () => {
  const otherFirm = randomUUID();
  await getDb()
    .insert(firmsTable)
    .values({ id: otherFirm, name: `VS Other ${SALT}` });
  const check = await computeVatSettlementCheck(otherFirm, monthStart);
  assert.equal(check.acceptedCount, 0);
  assert.equal(check.acceptedTotal, "0.00");
  assert.equal(check.settledShare, null);
  assert.equal(check.unsettled.length, 0);
  assert.equal(check.unsettledTruncated, false);
});
