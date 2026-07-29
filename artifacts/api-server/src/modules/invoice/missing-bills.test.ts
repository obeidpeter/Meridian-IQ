import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  getDb,
  engagementsTable,
  firmsTable,
  invoicesTable,
  partiesTable,
} from "@workspace/db";
import {
  countFirmMissingBills,
  listMissingRecurringBills,
  missingBillAlertFor,
} from "./missing-bills.ts";
import { daysAgo, makeRunSalt } from "../../test-helpers/fixtures.ts";

// Missing recurring bills (round-18 idea #3) — the payables mirror of
// unbilled-income. Pinned invariants:
//  - the projection is pure and shares detectMonthlyPattern verbatim, so
//    "a vendor habit" and "a billing habit" can never disagree; the alert
//    only fires inside the bounded [grace, max] window;
//  - tenancy mirrors the bills ledger (firm + client-as-buyer scoping);
//    a vendor's RECEIVABLE-side twin never pollutes the cadence;
//  - nothing is stored; the firm-wide digest count sees the same alerts,
//    restricted to clients with a LIVE engagement.

const SALT = makeRunSalt();
const firmId = randomUUID();
const clientParty = randomUUID(); // engaged — bills' buyer
const vendorDue = randomUUID(); // monthly habit, capture ~10 days late
const vendorFresh = randomUUID(); // monthly habit, freshly captured
const vendorLapsed = randomUUID(); // habit went silent months ago

const bill = (over: {
  supplierPartyId: string;
  invoiceNumber: string;
  issueDate: string;
  grandTotal?: string;
  currency?: string;
}) => ({
  firmId,
  supplierPartyId: over.supplierPartyId,
  buyerPartyId: clientParty,
  invoiceNumber: over.invoiceNumber,
  issueDate: over.issueDate,
  status: "draft" as const,
  currency: over.currency ?? "NGN",
  grandTotal: over.grandTotal ?? "80000.00",
  subtotal: "74418.60",
  vatTotal: "5581.40",
});

before(async () => {
  const db = getDb();
  await db.insert(firmsTable).values({ id: firmId, name: `MB Firm ${SALT}` });
  await db.insert(partiesTable).values([
    { id: clientParty, type: "client_business", legalName: `MB Client ${SALT}` },
    { id: vendorDue, type: "buyer", legalName: `MB Due Vendor ${SALT}` },
    { id: vendorFresh, type: "buyer", legalName: `MB Fresh Vendor ${SALT}` },
    { id: vendorLapsed, type: "buyer", legalName: `MB Lapsed Vendor ${SALT}` },
  ]);
  await db.insert(engagementsTable).values({
    firmId,
    clientPartyId: clientParty,
    type: "retainer",
    status: "open",
    title: `MB Engagement ${SALT}`,
  });
  await db.insert(invoicesTable).values([
    // Monthly capture habit whose next bill is ~10 days late: alert.
    bill({ supplierPartyId: vendorDue, invoiceNumber: `MB-D1-${SALT}`, issueDate: daysAgo(100) }),
    bill({ supplierPartyId: vendorDue, invoiceNumber: `MB-D2-${SALT}`, issueDate: daysAgo(70) }),
    bill({ supplierPartyId: vendorDue, invoiceNumber: `MB-D3-${SALT}`, issueDate: daysAgo(40) }),
    // A voided mis-capture 10 days ago must NOT advance the cadence —
    // cancelled paper is not evidence, and counting it would suppress the
    // genuine alert (lastIssueDate would look current).
    {
      ...bill({ supplierPartyId: vendorDue, invoiceNumber: `MB-DX-${SALT}`, issueDate: daysAgo(10) }),
      status: "cancelled" as const,
    },
    // Two USD one-offs from the SAME vendor, interleaved with the NGN habit
    // — merged (the pre-round-20 bug) they would drag the median gap under
    // the monthly floor and kill the alert; per-currency grouping keeps the
    // NGN cadence clean and the USD leg under the pattern minimum.
    bill({ supplierPartyId: vendorDue, invoiceNumber: `MB-DU1-${SALT}`, issueDate: daysAgo(55), currency: "USD", grandTotal: "300.00" }),
    bill({ supplierPartyId: vendorDue, invoiceNumber: `MB-DU2-${SALT}`, issueDate: daysAgo(50), currency: "USD", grandTotal: "300.00" }),
    // Same habit, captured 15 days ago: nothing is late yet.
    bill({ supplierPartyId: vendorFresh, invoiceNumber: `MB-F1-${SALT}`, issueDate: daysAgo(75) }),
    bill({ supplierPartyId: vendorFresh, invoiceNumber: `MB-F2-${SALT}`, issueDate: daysAgo(45) }),
    bill({ supplierPartyId: vendorFresh, invoiceNumber: `MB-F3-${SALT}`, issueDate: daysAgo(15) }),
    // Silent for months: the subscription ended — not a missing bill.
    bill({ supplierPartyId: vendorLapsed, invoiceNumber: `MB-L1-${SALT}`, issueDate: daysAgo(200) }),
    bill({ supplierPartyId: vendorLapsed, invoiceNumber: `MB-L2-${SALT}`, issueDate: daysAgo(170) }),
    bill({ supplierPartyId: vendorLapsed, invoiceNumber: `MB-L3-${SALT}`, issueDate: daysAgo(140) }),
  ]);
});

test("missingBillAlertFor projects the next capture and respects the window", () => {
  const b = (issueDate: string) => ({
    id: randomUUID(),
    issueDate,
    grandTotal: 80000,
  });
  const habit = [b("2026-01-10"), b("2026-02-09"), b("2026-03-11")];

  // 7 days past the projected 2026-04-10 capture: alert, honest numbers.
  const hit = missingBillAlertFor(habit, "2026-04-17");
  assert.ok(hit);
  assert.equal(hit.medianGapDays, 30);
  assert.equal(hit.expectedByDate, "2026-04-10");
  assert.equal(hit.overdueDays, 7);
  assert.equal(hit.lastIssueDate, "2026-03-11");
  assert.equal(hit.count, 3);
  assert.equal(hit.medianAmount, "80000");

  // Both window ends are inclusive: overdue day 5 is the first alert day…
  assert.ok(missingBillAlertFor(habit, "2026-04-15"));
  // …and overdue day 45 is the last.
  assert.ok(missingBillAlertFor(habit, "2026-05-25"));
  assert.equal(missingBillAlertFor(habit, "2026-05-26"), null);
  // Inside the grace window: vendor cadences wobble, stay quiet.
  assert.equal(missingBillAlertFor(habit, "2026-04-12"), null);
  // Not yet expected at all.
  assert.equal(missingBillAlertFor(habit, "2026-04-01"), null);
  // No pattern (too few bills), no alert.
  assert.equal(
    missingBillAlertFor([b("2026-01-10"), b("2026-02-09")], "2026-04-17"),
    null,
  );
});

test("listMissingRecurringBills flags exactly the late vendor habit", async () => {
  const alerts = await listMissingRecurringBills(firmId, clientParty);
  assert.equal(alerts.length, 1, "due only — not fresh or lapsed");
  const a = alerts[0];
  assert.equal(a.supplierPartyId, vendorDue);
  assert.equal(a.supplierName, `MB Due Vendor ${SALT}`);
  assert.equal(a.currency, "NGN", "the USD one-offs never pollute the cadence");
  assert.equal(a.medianGapDays, 30, "the NGN habit's own gap, unmixed");
  assert.equal(Number(a.medianAmount), 80000);
  assert.equal(a.count, 3);
  assert.ok(
    a.overdueDays >= 5 && a.overdueDays <= 45,
    `overdue ${a.overdueDays} inside the alert window`,
  );
});

test("another firm or another client sees nothing", async () => {
  assert.equal((await listMissingRecurringBills(randomUUID(), clientParty)).length, 0);
  assert.equal((await listMissingRecurringBills(firmId, randomUUID())).length, 0);
});

test("the firm-wide digest count sees the same alerts", async () => {
  const counts = await countFirmMissingBills(firmId);
  assert.equal(counts.alerts, 1);
  assert.equal(counts.clients, 1);
  const empty = await countFirmMissingBills(randomUUID());
  assert.equal(empty.alerts, 0);
  assert.equal(empty.clients, 0);
});

test("an archived engagement drops the client from the digest count", async () => {
  await getDb()
    .update(engagementsTable)
    .set({ status: "archived" })
    .where(eq(engagementsTable.firmId, firmId));
  try {
    const counts = await countFirmMissingBills(firmId);
    assert.equal(counts.alerts, 0, "no live engagement, no digest nagging");
    // The client's OWN card is unaffected — it mirrors the bills ledger,
    // whose orientation only needs the engagement to EXIST.
    assert.equal((await listMissingRecurringBills(firmId, clientParty)).length, 1);
  } finally {
    await getDb()
      .update(engagementsTable)
      .set({ status: "open" })
      .where(eq(engagementsTable.firmId, firmId));
  }
});
