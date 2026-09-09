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
import { daysAgo, makeRunSalt } from "../../test-helpers/fixtures.ts";

// Client compliance scorecard (round-19 idea #3). Pinned invariants:
//  - rates honour the sample floor: fewer than 3 observations shows as
//    null, never a scary 0% or a flattering 100%;
//  - withinWindowRate divides by ACCEPTED invoices; failureRate divides by
//    ATTEMPTED invoices — a client who never submits has no failure rate;
//  - "overdue now" is the digest predicate, not windowed;
//  - the table is engaged-clients-only, attention first (overdue paper,
//    then the weakest window rate, nulls last);
//  - failureRate counts BUSINESS REJECTIONS only (R95): a rail timeout or
//    5xx the platform failed over from is the platform's failure, not the
//    client's — an invoice with an error row AND an accepted row is accepted;
//  - the note pins posture-not-blame.

const SALT = makeRunSalt();
const firmId = randomUUID();
const clientA = randomUUID(); // active, one overdue draft, one failure
const clientB = randomUUID(); // tiny sample — rates must be null
const clientC = randomUUID(); // one failover, one rejection, one clean acceptance
const clientArchived = randomUUID(); // archived engagement — excluded
const buyer = randomUUID();
const vendor = randomUUID();

async function seedInvoice(input: {
  supplierPartyId?: string;
  buyerPartyId?: string;
  invoiceNumber: string;
  issueDate: string;
  status?: "draft" | "validated" | "stamped" | "cancelled" | "failed";
}): Promise<string> {
  const id = randomUUID();
  await getDb()
    .insert(invoicesTable)
    .values({
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
  status: "accepted" | "rejected" | "error",
  when: string,
  opts: { rail?: "rail_primary" | "rail_secondary"; errorCode?: string } = {},
): Promise<void> {
  await getDb()
    .insert(submissionAttemptsTable)
    .values({
      invoiceId,
      rail: opts.rail ?? "rail_primary",
      attemptNo: 1,
      idempotencyKey: randomUUID(),
      status,
      errorCode: opts.errorCode ?? null,
      createdAt: new Date(`${when}T09:00:00Z`),
    });
}

before(async () => {
  const db = getDb();
  await db.insert(firmsTable).values({ id: firmId, name: `SC Firm ${SALT}` });
  await db.insert(partiesTable).values([
    { id: clientA, type: "client_business", legalName: `SC Alpha ${SALT}` },
    { id: clientB, type: "client_business", legalName: `SC Beta ${SALT}` },
    { id: clientC, type: "client_business", legalName: `SC Gamma ${SALT}` },
    {
      id: clientArchived,
      type: "client_business",
      legalName: `SC Gone ${SALT}`,
    },
    { id: buyer, type: "buyer", legalName: `SC Buyer ${SALT}` },
    { id: vendor, type: "buyer", legalName: `SC Vendor ${SALT}` },
  ]);
  await db.insert(engagementsTable).values([
    {
      firmId,
      clientPartyId: clientA,
      type: "retainer",
      status: "open",
      title: `sc A ${SALT}`,
    },
    {
      firmId,
      clientPartyId: clientB,
      type: "retainer",
      status: "open",
      title: `sc B ${SALT}`,
    },
    {
      firmId,
      clientPartyId: clientC,
      type: "retainer",
      status: "open",
      title: `sc C ${SALT}`,
    },
    {
      firmId,
      clientPartyId: clientArchived,
      type: "retainer",
      status: "archived",
      title: `sc X ${SALT}`,
    },
  ]);

  // Client A: 3 accepted (2 inside the window, 1 late), 1 of them also saw
  // a rejection first, plus 1 overdue draft (never attempted).
  const a1 = await seedInvoice({
    invoiceNumber: `SC-A1-${SALT}`,
    issueDate: daysAgo(60),
  });
  await seedAttempt(a1, "accepted", daysAgo(58)); // +2d: inside window
  const a2 = await seedInvoice({
    invoiceNumber: `SC-A2-${SALT}`,
    issueDate: daysAgo(50),
  });
  await seedAttempt(a2, "rejected", daysAgo(49));
  await seedAttempt(a2, "accepted", daysAgo(46)); // +4d: inside window
  const a3 = await seedInvoice({
    invoiceNumber: `SC-A3-${SALT}`,
    issueDate: daysAgo(40),
  });
  await seedAttempt(a3, "accepted", daysAgo(28)); // +12d: outside window
  // The deadline boundary: accepted exactly on day issue+7. The overdue
  // predicate says day 7 IS late (issue + window <= today), so this must
  // NOT count as within-window — the review-confirmed off-by-one.
  const a5 = await seedInvoice({
    invoiceNumber: `SC-A5-${SALT}`,
    issueDate: daysAgo(35),
  });
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
  // PRIOR window (round-20 trend): three invoices issued 120-100 days ago,
  // all accepted LATE — prevWithinWindowRate 0 against the current 1/2,
  // an improving client.
  for (const [i, age] of [120, 110, 100].entries()) {
    const p = await seedInvoice({
      invoiceNumber: `SC-AP${i}-${SALT}`,
      issueDate: daysAgo(age),
    });
    await seedAttempt(p, "accepted", daysAgo(age - 10)); // +10d: late
  }

  // Client B: one stamped invoice, one accepted attempt — under every floor.
  const b1 = await seedInvoice({
    supplierPartyId: clientB,
    invoiceNumber: `SC-B1-${SALT}`,
    issueDate: daysAgo(30),
  });
  await seedAttempt(b1, "accepted", daysAgo(29));

  // Client C (R95): three attempted invoices — c1 failed over (rail_primary
  // error, rail_secondary accepted, one try), c2 was rejected, c3 accepted
  // cleanly. Two accepted (under the window-rate floor), one failure.
  const c1 = await seedInvoice({
    supplierPartyId: clientC,
    invoiceNumber: `SC-C1-${SALT}`,
    issueDate: daysAgo(30),
  });
  await seedAttempt(c1, "error", daysAgo(29), {
    rail: "rail_primary",
    errorCode: "RAIL_UNAVAILABLE",
  });
  await seedAttempt(c1, "accepted", daysAgo(29), { rail: "rail_secondary" });
  const c2 = await seedInvoice({
    supplierPartyId: clientC,
    invoiceNumber: `SC-C2-${SALT}`,
    issueDate: daysAgo(3),
    status: "failed",
  });
  await seedAttempt(c2, "rejected", daysAgo(2), {
    errorCode: "MBS_INVALID_TIN",
  });
  const c3 = await seedInvoice({
    supplierPartyId: clientC,
    invoiceNumber: `SC-C3-${SALT}`,
    issueDate: daysAgo(20),
  });
  await seedAttempt(c3, "accepted", daysAgo(19));

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
  assert.equal(scorecard.rows.length, 3, "engaged clients only");
  assert.match(scorecard.note, /not a verdict/);

  // No overdue paper and no window rate for B or C: name order, B then C.
  const [first, second, third] = scorecard.rows;
  assert.equal(third.clientPartyId, clientC);
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
  // The trend baseline: the prior window's three late acceptances give a
  // 0% within-window rate (current is 1/2 — improving), no prior failures.
  assert.equal(first.prevWithinWindowRate, 0);
  assert.equal(first.prevFailureRate, 0);
  assert.equal(second.prevWithinWindowRate, null, "no prior sample");
  assert.ok(
    first.medianDaysToStamp !== null && first.medianDaysToStamp >= 2,
    "median issue-to-stamp is computed",
  );

  assert.equal(second.clientPartyId, clientB);
  assert.equal(second.withinWindowRate, null, "1 accepted is under the floor");
  assert.equal(second.failureRate, null, "1 attempted is under the floor");
  assert.equal(second.overdueNow, 0);
});

test("a failover's error row is not a failure; a rejection is", async () => {
  const scorecard = await computeComplianceScorecard(firmId);
  const gamma = scorecard.rows.find((r) => r.clientPartyId === clientC);
  assert.ok(gamma, "client C is on the table");
  assert.equal(gamma.issuedCount, 3);
  assert.equal(gamma.acceptedCount, 2, "c1 (failed over) and c3 are accepted");
  // 3 attempted, only c2 was REJECTED: c1's RAIL_UNAVAILABLE row on
  // rail_primary is the platform's failure, and its rail_secondary
  // acceptance makes it an accepted invoice.
  assert.ok(
    gamma.failureRate !== null && Math.abs(gamma.failureRate - 1 / 3) < 1e-9,
    `failureRate ${gamma.failureRate} — the rejection alone over 3 attempted`,
  );
  assert.equal(gamma.withinWindowRate, null, "2 accepted is under the floor");
  assert.equal(gamma.overdueNow, 0);
});

test("another firm sees an empty table", async () => {
  const scorecard = await computeComplianceScorecard(randomUUID());
  assert.deepEqual(scorecard.rows, []);
});
