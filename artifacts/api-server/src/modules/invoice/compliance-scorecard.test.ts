import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  getDb,
  engagementsTable,
  firmsTable,
  invoicesTable,
  partiesTable,
  submissionAttemptsTable,
} from "@workspace/db";
import { computeComplianceScorecard } from "./compliance-scorecard.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Client compliance scorecard (round-19 idea #3). Pinned invariants:
//  - rates honour the sample floor: fewer than 3 observations shows as
//    null, never a scary 0% or a flattering 100%;
//  - withinWindowRate divides by ACCEPTED invoices; failureRate divides by
//    ATTEMPTED invoices — a client who never submits has no failure rate;
//  - "overdue now" is the digest predicate, not windowed;
//  - the table is engaged-clients-only, attention first (overdue paper,
//    then the weakest window rate, nulls last);
//  - the note pins posture-not-blame.

const SALT = makeRunSalt();
const firmId = randomUUID();
const clientA = randomUUID(); // active, one overdue draft, one failure
const clientB = randomUUID(); // tiny sample — rates must be null
const clientArchived = randomUUID(); // archived engagement — excluded
const buyer = randomUUID();
const vendor = randomUUID();

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

async function seedInvoice(input: {
  supplierPartyId?: string;
  buyerPartyId?: string;
  invoiceNumber: string;
  issueDate: string;
  status?: "draft" | "validated" | "stamped" | "cancelled";
}): Promise<string> {
  const id = randomUUID();
  await getDb().insert(invoicesTable).values({
    id,
    firmId,
    supplierPartyId: input.supplierPartyId ?? clientA,
    buyerPartyId: input.buyerPartyId ?? buyer,
    invoiceNumber: input.invoiceNumber,
    issueDate: input.issueDate,
    status: input.status ?? "stamped",
    grandTotal: "100000.00",
    subtotal: "93023.26",
    vatTotal: "6976.74",
  });
  return id;
}

async function seedAttempt(
  invoiceId: string,
  status: "accepted" | "rejected",
  when: string,
): Promise<void> {
  await getDb().insert(submissionAttemptsTable).values({
    invoiceId,
    rail: "rail_primary",
    attemptNo: 1,
    idempotencyKey: randomUUID(),
    status,
    createdAt: new Date(`${when}T09:00:00Z`),
  });
}

before(async () => {
  const db = getDb();
  await db.insert(firmsTable).values({ id: firmId, name: `SC Firm ${SALT}` });
  await db.insert(partiesTable).values([
    { id: clientA, type: "client_business", legalName: `SC Alpha ${SALT}` },
    { id: clientB, type: "client_business", legalName: `SC Beta ${SALT}` },
    { id: clientArchived, type: "client_business", legalName: `SC Gone ${SALT}` },
    { id: buyer, type: "buyer", legalName: `SC Buyer ${SALT}` },
    { id: vendor, type: "buyer", legalName: `SC Vendor ${SALT}` },
  ]);
  await db.insert(engagementsTable).values([
    { firmId, clientPartyId: clientA, type: "retainer", status: "open", title: `sc A ${SALT}` },
    { firmId, clientPartyId: clientB, type: "retainer", status: "open", title: `sc B ${SALT}` },
    { firmId, clientPartyId: clientArchived, type: "retainer", status: "archived", title: `sc X ${SALT}` },
  ]);

  // Client A: 3 accepted (2 inside the window, 1 late), 1 of them also saw
  // a rejection first, plus 1 overdue draft (never attempted).
  const a1 = await seedInvoice({ invoiceNumber: `SC-A1-${SALT}`, issueDate: daysAgo(60) });
  await seedAttempt(a1, "accepted", daysAgo(58)); // +2d: inside window
  const a2 = await seedInvoice({ invoiceNumber: `SC-A2-${SALT}`, issueDate: daysAgo(50) });
  await seedAttempt(a2, "rejected", daysAgo(49));
  await seedAttempt(a2, "accepted", daysAgo(46)); // +4d: inside window
  const a3 = await seedInvoice({ invoiceNumber: `SC-A3-${SALT}`, issueDate: daysAgo(40) });
  await seedAttempt(a3, "accepted", daysAgo(28)); // +12d: outside window
  // The deadline boundary: accepted exactly on day issue+7. The overdue
  // predicate says day 7 IS late (issue + window <= today), so this must
  // NOT count as within-window — the review-confirmed off-by-one.
  const a5 = await seedInvoice({ invoiceNumber: `SC-A5-${SALT}`, issueDate: daysAgo(35) });
  await seedAttempt(a5, "accepted", daysAgo(28)); // +7d: the boundary — late
  await seedInvoice({
    invoiceNumber: `SC-A4-${SALT}`,
    issueDate: daysAgo(20),
    status: "draft", // overdue now, no attempts
  });
  // A bill for client A (client is BUYER) with no verification recorded.
  await seedInvoice({
    supplierPartyId: vendor,
    buyerPartyId: clientA,
    invoiceNumber: `SC-AB1-${SALT}`,
    issueDate: daysAgo(15),
    status: "draft",
  });
  // A CANCELLED bill: a voided mis-capture is not a posture gap and must
  // not count as unverified (the vat-position rule).
  await seedInvoice({
    supplierPartyId: vendor,
    buyerPartyId: clientA,
    invoiceNumber: `SC-AB2-${SALT}`,
    issueDate: daysAgo(12),
    status: "cancelled",
  });

  // Client B: one stamped invoice, one accepted attempt — under every floor.
  const b1 = await seedInvoice({
    supplierPartyId: clientB,
    invoiceNumber: `SC-B1-${SALT}`,
    issueDate: daysAgo(30),
  });
  await seedAttempt(b1, "accepted", daysAgo(29));

  // The archived client's paper must not appear at all.
  await seedInvoice({
    supplierPartyId: clientArchived,
    invoiceNumber: `SC-X1-${SALT}`,
    issueDate: daysAgo(25),
    status: "draft",
  });
});

test("the scorecard ranks attention first with floored rates", async () => {
  const scorecard = await computeComplianceScorecard(firmId);
  assert.equal(scorecard.rows.length, 2, "engaged clients only");
  assert.match(scorecard.note, /not a verdict/);

  const [first, second] = scorecard.rows;
  assert.equal(first.clientPartyId, clientA, "overdue paper leads");
  assert.equal(first.clientName, `SC Alpha ${SALT}`);
  assert.equal(first.issuedCount, 5);
  assert.equal(first.acceptedCount, 4);
  // 2 of 4 accepted landed INSIDE the window: +2 and +4 count, +12 does
  // not, and the +7 boundary is LATE (the overdue predicate's day-7 rule).
  assert.ok(
    first.withinWindowRate !== null &&
      Math.abs(first.withinWindowRate - 2 / 4) < 1e-9,
    `withinWindowRate ${first.withinWindowRate} — the day-7 boundary is late`,
  );
  // 4 invoices were attempted (a4 never was); only a2 saw a rejection.
  assert.ok(
    first.failureRate !== null && Math.abs(first.failureRate - 1 / 4) < 1e-9,
    `failureRate ${first.failureRate} — rejected a2 over 4 attempted invoices`,
  );
  assert.equal(first.overdueNow, 1);
  assert.equal(first.unverifiedBills, 1);
  assert.ok(
    first.medianDaysToStamp !== null && first.medianDaysToStamp >= 2,
    "median issue-to-stamp is computed",
  );

  assert.equal(second.clientPartyId, clientB);
  assert.equal(second.withinWindowRate, null, "1 accepted is under the floor");
  assert.equal(second.failureRate, null, "1 attempted is under the floor");
  assert.equal(second.overdueNow, 0);
});

test("another firm sees an empty table", async () => {
  const scorecard = await computeComplianceScorecard(randomUUID());
  assert.deepEqual(scorecard.rows, []);
});
