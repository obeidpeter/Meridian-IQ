import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  getDb,
  engagementsTable,
  firmsTable,
  partiesTable,
  invoicesTable,
  usersTable,
  recurringInvoiceTemplatesTable,
} from "@workspace/db";
import {
  countFirmUnbilled,
  listUnbilledIncome,
  unbilledAlertFor,
} from "./unbilled-income.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Unbilled-income detection (round-8 idea #1). Pinned invariants:
//  - the projection is pure: expected = last issue + median gap, alert only
//  inside the bounded [grace, max] window — never before the habit is
//  actually late, never forever after an arrangement ends;
//  - the mining shares the recurring-suggestion thresholds and template
//  exclusions, so the two cards can never disagree about what a habit is;
//  - tenancy mirrors the suggestions (firm + client party scoping);
//  - nothing is stored; the firm-wide digest count sees the same alerts.

const SALT = makeRunSalt();
const firmId = randomUUID();
const clientId = randomUUID();
const buyerDue = randomUUID();
const buyerFresh = randomUUID();
const buyerLapsed = randomUUID();
const buyerCovered = randomUUID();
const userId = randomUUID();

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

const row = (over: {
  buyerPartyId: string;
  invoiceNumber: string;
  issueDate: string;
  grandTotal?: string;
}) => ({
  firmId,
  supplierPartyId: clientId,
  buyerPartyId: over.buyerPartyId,
  invoiceNumber: over.invoiceNumber,
  issueDate: over.issueDate,
  status: "stamped" as const,
  grandTotal: over.grandTotal ?? "200000.00",
  subtotal: "186046.51",
  vatTotal: "13953.49",
});

before(async () => {
  const db = getDb();
  await db.insert(firmsTable).values({ id: firmId, name: `UB Firm ${SALT}` });
  await db
    .insert(usersTable)
    .values({ id: userId, email: `ub-${SALT}@test.example` })
    .onConflictDoNothing();
  await db.insert(partiesTable).values([
    { id: clientId, type: "client_business", legalName: `UB Client ${SALT}` },
    { id: buyerDue, type: "buyer", legalName: `UB Due Buyer ${SALT}` },
    { id: buyerFresh, type: "buyer", legalName: `UB Fresh Buyer ${SALT}` },
    { id: buyerLapsed, type: "buyer", legalName: `UB Lapsed Buyer ${SALT}` },
    { id: buyerCovered, type: "buyer", legalName: `UB Covered Buyer ${SALT}` },
  ]);
  await db.insert(invoicesTable).values([
    // Monthly habit whose next invoice is ~10 days late: alert.
    row({ buyerPartyId: buyerDue, invoiceNumber: `UB-D1-${SALT}`, issueDate: daysAgo(100) }),
    row({ buyerPartyId: buyerDue, invoiceNumber: `UB-D2-${SALT}`, issueDate: daysAgo(70) }),
    row({ buyerPartyId: buyerDue, invoiceNumber: `UB-D3-${SALT}`, issueDate: daysAgo(40) }),
    // Same habit, freshly billed 15 days ago: nothing is late yet.
    row({ buyerPartyId: buyerFresh, invoiceNumber: `UB-F1-${SALT}`, issueDate: daysAgo(75) }),
    row({ buyerPartyId: buyerFresh, invoiceNumber: `UB-F2-${SALT}`, issueDate: daysAgo(45) }),
    row({ buyerPartyId: buyerFresh, invoiceNumber: `UB-F3-${SALT}`, issueDate: daysAgo(15) }),
    // A habit that went silent months ago: the arrangement ended, no nagging.
    row({ buyerPartyId: buyerLapsed, invoiceNumber: `UB-L1-${SALT}`, issueDate: daysAgo(200) }),
    row({ buyerPartyId: buyerLapsed, invoiceNumber: `UB-L2-${SALT}`, issueDate: daysAgo(170) }),
    row({ buyerPartyId: buyerLapsed, invoiceNumber: `UB-L3-${SALT}`, issueDate: daysAgo(140) }),
    // Late like buyerDue — but a template covers it (the recurring engine's
    // problem, not this card's).
    row({ buyerPartyId: buyerCovered, invoiceNumber: `UB-C1-${SALT}`, issueDate: daysAgo(100) }),
    row({ buyerPartyId: buyerCovered, invoiceNumber: `UB-C2-${SALT}`, issueDate: daysAgo(70) }),
    row({ buyerPartyId: buyerCovered, invoiceNumber: `UB-C3-${SALT}`, issueDate: daysAgo(40) }),
  ]);
  await db.insert(recurringInvoiceTemplatesTable).values({
    firmId,
    supplierPartyId: clientId,
    buyerPartyId: buyerCovered,
    name: `UB Covered ${SALT}`,
    cadence: "monthly",
    nextRunDate: daysAgo(0),
    active: false,
    lines: [
      { description: "x", quantity: "1", unitPrice: "1", vatRate: "0.075" },
    ],
    createdByUserId: userId,
  });
  // The firm-wide digest count only sees clients with a LIVE engagement.
  await db.insert(engagementsTable).values({
    firmId,
    clientPartyId: clientId,
    type: "retainer",
    status: "open",
    title: `UB Engagement ${SALT}`,
  });
});

test("unbilledAlertFor projects the next date and respects the window", () => {
  const inv = (issueDate: string) => ({
    id: randomUUID(),
    issueDate,
    grandTotal: 200000,
  });
  const habit = [inv("2026-01-10"), inv("2026-02-09"), inv("2026-03-11")];

  // 7 days past the projected 2026-04-10: alert, with honest numbers.
  const hit = unbilledAlertFor(habit, "2026-04-17");
  assert.ok(hit);
  assert.equal(hit.medianGapDays, 30);
  assert.equal(hit.expectedByDate, "2026-04-10");
  assert.equal(hit.overdueDays, 7);
  assert.equal(hit.lastIssueDate, "2026-03-11");
  assert.equal(hit.count, 3);

  // The grace boundary is inclusive: overdue day 5 is the first alert day.
  assert.ok(unbilledAlertFor(habit, "2026-04-15"));
  // Inside the grace window: cadences wobble, stay quiet.
  assert.equal(unbilledAlertFor(habit, "2026-04-12"), null);
  // Not yet due at all.
  assert.equal(unbilledAlertFor(habit, "2026-04-01"), null);
  // Months of silence: the arrangement ended, stop nagging.
  assert.equal(unbilledAlertFor(habit, "2026-06-10"), null);
  // No pattern, no alert.
  assert.equal(
    unbilledAlertFor([inv("2026-01-10"), inv("2026-02-09")], "2026-04-17"),
    null,
  );
});

test("listUnbilledIncome flags exactly the late habit", async () => {
  const alerts = await listUnbilledIncome(firmId, clientId);
  assert.equal(alerts.length, 1, "due only — not fresh, lapsed or covered");
  const a = alerts[0];
  assert.equal(a.buyerPartyId, buyerDue);
  assert.equal(a.buyerName, `UB Due Buyer ${SALT}`);
  assert.equal(Number(a.medianAmount), 200000);
  assert.ok(
    a.overdueDays >= 5 && a.overdueDays <= 45,
    `overdue ${a.overdueDays} inside the alert window`,
  );
});

test("another firm or another client sees nothing", async () => {
  assert.equal((await listUnbilledIncome(randomUUID(), clientId)).length, 0);
  assert.equal((await listUnbilledIncome(firmId, randomUUID())).length, 0);
});

test("the firm-wide digest count sees the same alerts", async () => {
  const counts = await countFirmUnbilled(firmId);
  assert.equal(counts.alerts, 1);
  assert.equal(counts.clients, 1);
  // A firm with no history is a quiet fact, not an error.
  const empty = await countFirmUnbilled(randomUUID());
  assert.equal(empty.alerts, 0);
  assert.equal(empty.clients, 0);
});

test("an archived engagement drops the client from the digest count", async () => {
  await getDb()
    .update(engagementsTable)
    .set({ status: "archived" })
    .where(eq(engagementsTable.firmId, firmId));
  try {
    const counts = await countFirmUnbilled(firmId);
    assert.equal(counts.alerts, 0, "no live engagement, no digest nagging");
    // The client's OWN card is unaffected — it mirrors the suggestions.
    assert.equal((await listUnbilledIncome(firmId, clientId)).length, 1);
  } finally {
    await getDb()
      .update(engagementsTable)
      .set({ status: "open" })
      .where(eq(engagementsTable.firmId, firmId));
  }
});
