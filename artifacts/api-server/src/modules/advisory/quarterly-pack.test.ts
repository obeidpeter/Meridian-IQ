import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  getDb,
  firmsTable,
  partiesTable,
  invoicesTable,
  usersTable,
  submissionAttemptsTable,
  clerkCasesTable,
} from "@workspace/db";
import {
  closedLagosQuarters,
  computeQuarterlyReview,
  quarterLabel,
  quarterMonths,
} from "./quarterly-pack.ts";
import { quarterlyNoteFacts, templateQuarterlyNote } from "./quarterly-note.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Quarterly review pack (round-13 idea #4). Pinned invariants:
//  - the quarter's VAT figures are the monthly VAT packs summed — same
//    predicate (issue month, rails-accepted, cancelled excluded);
//  - submission counts cover attempts MADE in the quarter (Lagos windows),
//    so an old invoice accepted after the quarter counts in the pack's VAT
//    (issue basis) but not in the quarter's submission activity;
//  - the receivables snapshot is as-of-now, per currency, firm-scoped;
//  - Clerk throughput counts extraction cases OPENED in the quarter.
// The seeded firm is unique to this test, so its numbers are exact.

const SALT = makeRunSalt();
const CODE = `QR_${SALT.toUpperCase()}`;
const firmId = randomUUID();
const clientId = randomUUID();
const buyerId = randomUUID();
const userId = randomUUID();

const quarterStart = closedLagosQuarters()[0];
const [qy, qm] = quarterStart.split("-").map(Number);
const inQuarterDate = (monthOffset: number, day: number) => {
  const d = new Date(Date.UTC(qy, qm - 1 + monthOffset, day));
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${d.getUTCFullYear()}-${mm}-${String(d.getUTCDate()).padStart(2, "0")}`;
};
// 12:00 UTC = 13:00 Lagos — safely inside the Lagos day and the quarter.
const inQuarterTs = (monthOffset: number, day: number) =>
  new Date(Date.UTC(qy, qm - 1 + monthOffset, day, 12));

before(async () => {
  const db = getDb();
  await db.insert(firmsTable).values({ id: firmId, name: `QR Firm ${SALT}` });
  await db
    .insert(usersTable)
    .values({ id: userId, email: `qr-${SALT}@test.example` })
    .onConflictDoNothing();
  await db.insert(partiesTable).values([
    { id: clientId, type: "client_business", legalName: `QR Client ${SALT}` },
    { id: buyerId, type: "buyer", legalName: `QR Buyer ${SALT}` },
  ]);

  const mkInvoice = async (
    n: string,
    issueDate: string,
    status: string,
    grand: string,
    vat: string,
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
      vatTotal: vat,
    });
    return id;
  };
  const attempt = async (
    invoiceId: string,
    no: number,
    status: string,
    errorCode: string | null,
    createdAt: Date,
  ) => {
    await db.insert(submissionAttemptsTable).values({
      invoiceId,
      rail: "rail_primary",
      attemptNo: no,
      idempotencyKey: `qr-${invoiceId}-${no}`,
      status: status as never,
      errorCode,
      createdAt,
    });
  };

  // Month 1: accepted inside the quarter — counts everywhere.
  const inv1 = await mkInvoice(
    `QR-1-${SALT}`,
    inQuarterDate(0, 5),
    "settled",
    "1000.00",
    "75.00",
  );
  await attempt(inv1, 1, "accepted", null, inQuarterTs(0, 6));
  // Month 3: accepted AFTER the quarter closed (a late retry) — in the VAT
  // pack (issue basis) but not in the quarter's submission activity.
  const inv2 = await mkInvoice(
    `QR-2-${SALT}`,
    inQuarterDate(2, 10),
    "settled",
    "2000.00",
    "150.00",
  );
  await attempt(inv2, 1, "accepted", null, new Date());
  // Month 2: rejected in-quarter, still outstanding today — feeds the
  // rejection rows and the receivables snapshot, never the VAT pack.
  const inv3 = await mkInvoice(
    `QR-3-${SALT}`,
    inQuarterDate(1, 15),
    "submitted",
    "500.00",
    "37.50",
  );
  await attempt(inv3, 1, "rejected", CODE, inQuarterTs(1, 16));

  await db.insert(clerkCasesTable).values({
    kind: "extraction",
    status: "approved",
    sourceType: "text",
    firmId,
    createdBy: userId,
    decidedBy: userId,
    createdAt: inQuarterTs(1, 20),
    updatedAt: inQuarterTs(1, 21),
  });
});

test("quarter helpers: closed quarters, months and labels (Lagos calendar)", () => {
  // 2026-07-17 UTC noon is July in Lagos → current quarter Q3, newest closed Q2.
  const now = new Date("2026-07-17T12:00:00Z");
  assert.deepEqual(closedLagosQuarters(4, now), [
    "2026-04-01",
    "2026-01-01",
    "2025-10-01",
    "2025-07-01",
  ]);
  assert.deepEqual(quarterMonths("2026-04-01"), [
    "2026-04-01",
    "2026-05-01",
    "2026-06-01",
  ]);
  assert.equal(quarterLabel("2026-04-01"), "Q2 2026 (April – June)");
  assert.equal(quarterLabel("2025-10-01"), "Q4 2025 (October – December)");
  // 23:30 UTC on Dec 31 is already Jan 1 00:30 in Lagos → Q1 2026 is current.
  assert.equal(
    closedLagosQuarters(1, new Date("2025-12-31T23:30:00Z"))[0],
    "2025-10-01",
  );
});

test("the review assembles the quarter's own numbers exactly", async () => {
  const review = await computeQuarterlyReview(firmId, quarterStart);

  assert.equal(review.quarterStart, quarterStart);
  assert.ok(review.quarters.includes(quarterStart));
  assert.equal(review.months.length, 3);

  // VAT = the monthly packs summed: inv1 in month 1, inv2 in month 3 (its
  // late acceptance still counts on the issue basis), inv3 never accepted.
  assert.equal(review.months[0].acceptedCount, 1);
  assert.equal(review.months[1].acceptedCount, 0);
  assert.equal(review.months[2].acceptedCount, 1);
  assert.equal(review.vatTotals.acceptedCount, 2);
  assert.equal(review.vatTotals.acceptedVat, "225.00");
  assert.equal(review.vatTotals.netVat, "225.00");

  // Submission activity is what happened IN the quarter: inv1's acceptance
  // and inv3's rejection; inv2's late acceptance is outside.
  assert.equal(review.submissions.accepted, 1);
  assert.equal(review.submissions.rejected, 1);
  assert.equal(review.rejectionTotal, 1);
  const rejection = review.topRejections.find((r) => r.errorCode === CODE);
  assert.ok(rejection, "the quarter's rejection code reports");
  assert.equal(rejection.count, 1);

  // Receivables snapshot: only inv3 is still outstanding for this firm.
  const ngn = review.receivables.groups.find((g) => g.currency === "NGN");
  assert.ok(ngn, "the outstanding invoice's currency group exists");
  assert.equal(ngn.invoiceCount, 1);
  assert.equal(ngn.outstandingTotal, "500.00");

  // Clerk throughput: the one extraction case opened in the quarter.
  assert.equal(review.clerk.captures, 1);
  assert.equal(review.clerk.approved, 1);
  assert.equal(review.clerk.rejected, 0);

  assert.match(review.note, /review aid, not a filing/);
});

test("another firm sees none of it", async () => {
  const otherFirm = randomUUID();
  await getDb()
    .insert(firmsTable)
    .values({ id: otherFirm, name: `QR Other ${SALT}` });
  const review = await computeQuarterlyReview(otherFirm, quarterStart);
  assert.equal(review.vatTotals.acceptedCount, 0);
  assert.equal(review.submissions.accepted, 0);
  assert.equal(review.rejectionTotal, 0);
  assert.equal(review.receivables.groups.length, 0);
  assert.equal(review.clerk.captures, 0);
});

test("the template note and facts stay grounded in the computed pack", async () => {
  const review = await computeQuarterlyReview(firmId, quarterStart);
  const note = templateQuarterlyNote(review);
  assert.ok(note.includes(review.quarterLabel));
  assert.ok(note.includes(review.vatTotals.netVat));
  assert.ok(note.includes("1 submission attempt(s) were rejected"));

  const facts = quarterlyNoteFacts(review);
  assert.ok(facts.includes(`Quarter: ${review.quarterLabel}`));
  assert.ok(facts.includes("Basis note:"));
  assert.ok(facts.includes(CODE), "top rejection codes reach the facts");
});
