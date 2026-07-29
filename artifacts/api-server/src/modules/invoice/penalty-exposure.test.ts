import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  getDb,
  engagementsTable,
  firmsTable,
  invoicesTable,
  partiesTable,
} from "@workspace/db";
import {
  bandExposure,
  computePenaltyExposure,
  S104_PER_INVOICE,
} from "./penalty-exposure.ts";
import { daysAgo, makeRunSalt } from "../../test-helpers/fixtures.ts";

// Penalty exposure (round-18 idea #2). Pinned here:
//  - the per-invoice charges are the PUBLISHED calculator model
//    (artifacts/penalty-calculator/src/lib/penalty.ts) — the standalone
//    artifact cannot be imported, so this test pins the mirrored values and
//    fails the moment either side drifts;
//  - "overdue" is the digest predicate: draft/validated RECEIVABLE paper
//    past issue + submission window — a submitted invoice, a bill, and
//    fresh paper never count;
//  - all three bands are always reported, and the digest floor is the
//    SMALL band (never a scare figure), null when nothing is overdue;
//  - the note pins estimate-not-advice.

const SALT = makeRunSalt();
const firmId = randomUUID();
const clientParty = randomUUID();
const siblingParty = randomUUID();
const buyerParty = randomUUID();
const vendorParty = randomUUID(); // not engaged — supplies the bill probe

let oldestOverdueId: string;

const row = (over: {
  supplierPartyId?: string;
  buyerPartyId?: string;
  invoiceNumber: string;
  issueDate: string;
  status?: "draft" | "validated" | "stamped";
}) => ({
  id: randomUUID(),
  firmId,
  supplierPartyId: over.supplierPartyId ?? clientParty,
  buyerPartyId: over.buyerPartyId ?? buyerParty,
  invoiceNumber: over.invoiceNumber,
  issueDate: over.issueDate,
  status: over.status ?? ("draft" as const),
  grandTotal: "150000.00",
  subtotal: "139534.88",
  vatTotal: "10465.12",
});

before(async () => {
  const db = getDb();
  await db.insert(firmsTable).values({ id: firmId, name: `PX Firm ${SALT}` });
  await db.insert(partiesTable).values([
    { id: clientParty, type: "client_business", legalName: `PX Client ${SALT}` },
    { id: siblingParty, type: "client_business", legalName: `PX Sibling ${SALT}` },
    { id: buyerParty, type: "buyer", legalName: `PX Buyer ${SALT}` },
    { id: vendorParty, type: "buyer", legalName: `PX Vendor ${SALT}` },
  ]);
  await db.insert(engagementsTable).values([
    { firmId, clientPartyId: clientParty, type: "retainer", title: `px A ${SALT}` },
    { firmId, clientPartyId: siblingParty, type: "retainer", title: `px B ${SALT}` },
  ]);
  const oldest = row({
    invoiceNumber: `PX-OLD-${SALT}`,
    issueDate: daysAgo(40),
    status: "validated",
  });
  oldestOverdueId = oldest.id;
  await db.insert(invoicesTable).values([
    // Overdue: validated 40 days old (the oldest — sample leads with it)…
    oldest,
    // …a draft 20 days old…
    row({ invoiceNumber: `PX-MID-${SALT}`, issueDate: daysAgo(20) }),
    // …and the window boundary: issued exactly SUBMISSION_WINDOW_DAYS ago,
    // the first day issue + window <= today holds.
    row({ invoiceNumber: `PX-EDGE-${SALT}`, issueDate: daysAgo(7) }),
    // Fresh draft: still inside the window, never counted.
    row({ invoiceNumber: `PX-FRESH-${SALT}`, issueDate: daysAgo(2) }),
    // Already stamped: whatever its age, no s.104 candidate.
    row({
      invoiceNumber: `PX-DONE-${SALT}`,
      issueDate: daysAgo(60),
      status: "stamped",
    }),
    // A BILL (client on the buyer side): payables never accrue s.104 here.
    row({
      supplierPartyId: vendorParty,
      buyerPartyId: clientParty,
      invoiceNumber: `PX-BILL-${SALT}`,
      issueDate: daysAgo(30),
    }),
    // The sibling client's overdue draft: firm-wide yes, client pin no.
    row({
      supplierPartyId: siblingParty,
      invoiceNumber: `PX-SIB-${SALT}`,
      issueDate: daysAgo(15),
    }),
  ]);
});

test("S104_PER_INVOICE mirrors the published calculator model", () => {
  // artifacts/penalty-calculator/src/lib/penalty.ts — if the calculator's
  // published charges change, this mirror (and this pin) must move with it.
  assert.deepEqual(S104_PER_INVOICE, {
    small: 25_000,
    medium: 50_000,
    large: 100_000,
  });
});

test("bandExposure multiplies per band and clamps junk", () => {
  assert.deepEqual(bandExposure(3), {
    small: "75000",
    medium: "150000",
    large: "300000",
  });
  assert.deepEqual(bandExposure(0), { small: "0", medium: "0", large: "0" });
  // Negative or fractional counts cannot mint exposure.
  assert.deepEqual(bandExposure(-2), { small: "0", medium: "0", large: "0" });
  assert.equal(bandExposure(2.9).small, "50000");
});

test("firm-wide exposure counts exactly the overdue receivable paper", async () => {
  const report = await computePenaltyExposure(firmId);
  // validated(40d) + draft(20d) + boundary(7d) + sibling(15d) — never the
  // fresh draft, the stamped invoice or the bill.
  assert.equal(report.overdueCount, 4);
  assert.deepEqual(report.exposure, bandExposure(4));
  assert.deepEqual(report.perInvoice, {
    small: "25000",
    medium: "50000",
    large: "100000",
  });
  assert.equal(report.sampleInvoices.length, 4);
  // Oldest first — the paper to clear first.
  assert.equal(report.sampleInvoices[0].invoiceId, oldestOverdueId);
  assert.equal(report.sampleInvoices[0].invoiceNumber, `PX-OLD-${SALT}`);
  for (let i = 1; i < report.sampleInvoices.length; i++) {
    assert.ok(
      report.sampleInvoices[i - 1].daysOverdue >=
        report.sampleInvoices[i].daysOverdue,
      "sample is oldest (most overdue) first",
    );
  }
  for (const s of report.sampleInvoices) {
    assert.ok(s.daysOverdue >= 0, `daysOverdue ${s.daysOverdue} >= 0`);
  }
  assert.match(report.asOf, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(report.note, /estimate, not legal or tax advice/);
  assert.match(report.note, /small band/);
});

test("the client pin drops the sibling's paper (SEC-03 posture)", async () => {
  const report = await computePenaltyExposure(firmId, clientParty);
  assert.equal(report.overdueCount, 3);
  const numbers = report.sampleInvoices.map((s) => s.invoiceNumber);
  assert.ok(!numbers.includes(`PX-SIB-${SALT}`));
  // And a pin on a party with no overdue paper is a quiet zero, not an error.
  const empty = await computePenaltyExposure(firmId, randomUUID());
  assert.equal(empty.overdueCount, 0);
  assert.deepEqual(empty.sampleInvoices, []);
  assert.equal(empty.exposure.small, "0");
});

test("another firm sees nothing", async () => {
  const report = await computePenaltyExposure(randomUUID());
  assert.equal(report.overdueCount, 0);
  assert.deepEqual(report.sampleInvoices, []);
});

