import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  getDb,
  firmsTable,
  partiesTable,
  invoicesTable,
  usersTable,
  clerkCasesTable,
} from "@workspace/db";
import { computeAdoptionReport } from "./adoption.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Adoption & impact report (round-10 idea #3). Pinned invariants:
//  - attribution is by the APPROVED invoice's supplier party — the only
//  deterministic join for every capture path;
//  - kept-rate comes from the corrections exhaust (changed=false = kept);
//  - non-approved cases count in the firm totals, never against a client;
//  - firm isolation is absolute.

const SALT = makeRunSalt();
const firmId = randomUUID();
const clientA = randomUUID();
const clientB = randomUUID();
const buyerId = randomUUID();
const userId = randomUUID();

before(async () => {
  const db = getDb();
  await db.insert(firmsTable).values({ id: firmId, name: `AD Firm ${SALT}` });
  await db
    .insert(usersTable)
    .values({ id: userId, email: `ad-${SALT}@test.example` })
    .onConflictDoNothing();
  await db.insert(partiesTable).values([
    { id: clientA, type: "client_business", legalName: `AD Client A ${SALT}` },
    { id: clientB, type: "client_business", legalName: `AD Client B ${SALT}` },
    { id: buyerId, type: "buyer", legalName: `AD Buyer ${SALT}` },
  ]);

  const mkApproved = async (
    supplier: string,
    number: string,
    corrections: { field: string; changed: boolean }[],
  ) => {
    const invoiceId = randomUUID();
    await db.insert(invoicesTable).values({
      id: invoiceId,
      firmId,
      supplierPartyId: supplier,
      buyerPartyId: buyerId,
      invoiceNumber: number,
      issueDate: "2026-07-01",
      status: "stamped",
      grandTotal: "10000.00",
      subtotal: "9302.33",
      vatTotal: "697.67",
    });
    await db.insert(clerkCasesTable).values({
      kind: "extraction",
      status: "approved",
      sourceType: "text",
      firmId,
      createdBy: userId,
      decidedBy: userId,
      decisionAction: "approved",
      createdInvoiceId: invoiceId,
      corrections: corrections.map((c) => ({
        field: c.field,
        extracted: "x",
        final: c.changed ? "y" : "x",
        changed: c.changed,
      })),
    });
  };

  // Client A: two approvals, 4 fields judged, 3 kept.
  await mkApproved(clientA, `AD-A1-${SALT}`, [
    { field: "invoiceNumber", changed: false },
    { field: "grandTotal", changed: true },
  ]);
  await mkApproved(clientA, `AD-A2-${SALT}`, [
    { field: "invoiceNumber", changed: false },
    { field: "issueDate", changed: false },
  ]);
  // Client B: one approval, everything kept.
  await mkApproved(clientB, `AD-B1-${SALT}`, [
    { field: "invoiceNumber", changed: false },
  ]);
  // A pending case counts in totals, not against any client.
  await db.insert(clerkCasesTable).values({
    kind: "extraction",
    status: "extracted",
    sourceType: "text",
    firmId,
    createdBy: userId,
  });
});

test("the report attributes approvals to clients and keeps honest totals", async () => {
  const report = await computeAdoptionReport(firmId);
  assert.equal(report.totals.extractionCases, 4);
  assert.equal(report.totals.approvedCases, 3);
  assert.equal(report.totals.approvedShare, 0.75);
  // 5 fields judged across the firm, 4 kept.
  assert.equal(report.totals.keptRate, 0.8);

  assert.equal(report.clients.length, 2);
  const a = report.clients.find((c) => c.clientPartyId === clientA);
  const b = report.clients.find((c) => c.clientPartyId === clientB);
  assert.ok(a && b);
  assert.equal(a.clientName, `AD Client A ${SALT}`);
  assert.equal(a.approvedCases, 2);
  assert.equal(a.fieldsCompared, 4);
  assert.equal(a.fieldsKept, 3);
  assert.equal(a.keptRate, 0.75);
  assert.ok(a.avgReviewMinutes !== null && a.avgReviewMinutes >= 0);
  assert.equal(b.approvedCases, 1);
  assert.equal(b.keptRate, 1);
  // Volume order: A (2) before B (1).
  assert.equal(report.clients[0].clientPartyId, clientA);
});

test("another firm sees nothing", async () => {
  const foreign = await computeAdoptionReport(randomUUID());
  assert.equal(foreign.totals.extractionCases, 0);
  assert.equal(foreign.clients.length, 0);
  assert.equal(foreign.totals.approvedShare, 0);
});
