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
import { daysAgo, makeRunSalt } from "../../test-helpers/fixtures.ts";

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

const row = (over: {
  buyerPartyId: string;
  invoiceNumber: string;
  issueDate: string;
  grandTotal?: string;
  currency?: string;
}) => ({
  firmId,
  supplierPartyId: clientId,
  buyerPartyId: over.buyerPartyId,
  invoiceNumber: over.invoiceNumber,
  issueDate: over.issueDate,
  status: "stamped" as const,
  currency: over.currency ?? "NGN",
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
    // Two USD one-offs to the SAME buyer, interleaved with the NGN habit.
    // Merged into one history (the pre-round-20 bug) they would drag the
    // median gap under the monthly floor and KILL the alert — per-currency
    // grouping keeps the NGN cadence clean and the USD leg (2 invoices)
    // under the pattern minimum.
    row({ buyerPartyId: buyerDue, invoiceNumber: `UB-DU1-${SALT}`, issueDate: daysAgo(55), currency: "USD", grandTotal: "500.00" }),
    row({ buyerPartyId: buyerDue, invoiceNumber: `UB-DU2-${SALT}`, issueDate: daysAgo(50), currency: "USD", grandTotal: "500.00" }),
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
  assert.equal(
    alerts.length,
    1,
    "due only — not fresh, lapsed, covered, or the sub-minimum USD leg",
  );
  const a = alerts[0];
  assert.equal(a.buyerPartyId, buyerDue);
  assert.equal(a.buyerName, `UB Due Buyer ${SALT}`);
  assert.equal(a.currency, "NGN", "the USD one-offs never pollute the cadence");
  assert.equal(a.medianGapDays, 30, "the NGN habit's own gap, unmixed");
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

test("the top-N cut ranks by naira equivalent, not raw face value", async () => {
  // A USD 2,000 monthly retainer must outrank an NGN 100,000 one (at the
  // (buyer, currency) group's most recently captured fx_rate_to_ngn:
  // 2,000 x 1,500 = NGN 3,000,000), and a foreign habit with NO captured
  // rate ranks at face value only (never hidden, never converted at an
  // invented rate) — the ngnRankFor rule shared with missing-bills. Fresh
  // firm/client so the sibling tests' single-alert pins stay intact.
  const db = getDb();
  const fxFirm = randomUUID();
  const fxClient = randomUUID();
  const buyerNgn = randomUUID();
  const buyerUsd = randomUUID();
  const buyerEur = randomUUID();
  await db.insert(firmsTable).values({ id: fxFirm, name: `UB FX Firm ${SALT}` });
  await db.insert(partiesTable).values([
    { id: fxClient, type: "client_business", legalName: `UB FX Client ${SALT}` },
    { id: buyerNgn, type: "buyer", legalName: `UB FX NGN Buyer ${SALT}` },
    { id: buyerUsd, type: "buyer", legalName: `UB FX USD Buyer ${SALT}` },
    { id: buyerEur, type: "buyer", legalName: `UB FX EUR Buyer ${SALT}` },
  ]);
  const fxRow = (over: {
    buyerPartyId: string;
    invoiceNumber: string;
    issueDate: string;
    currency: string;
    grandTotal: string;
    fxRateToNgn?: string;
  }) => ({
    firmId: fxFirm,
    supplierPartyId: fxClient,
    buyerPartyId: over.buyerPartyId,
    invoiceNumber: over.invoiceNumber,
    issueDate: over.issueDate,
    status: "stamped" as const,
    currency: over.currency,
    grandTotal: over.grandTotal,
    subtotal: over.grandTotal,
    vatTotal: "0.00",
    fxRateToNgn: over.fxRateToNgn ?? null,
  });
  await db.insert(invoicesTable).values([
    // NGN habit, ~10 days late: face value 100,000.
    fxRow({ buyerPartyId: buyerNgn, invoiceNumber: `UBFX-N1-${SALT}`, issueDate: daysAgo(100), currency: "NGN", grandTotal: "100000.00" }),
    fxRow({ buyerPartyId: buyerNgn, invoiceNumber: `UBFX-N2-${SALT}`, issueDate: daysAgo(70), currency: "NGN", grandTotal: "100000.00" }),
    fxRow({ buyerPartyId: buyerNgn, invoiceNumber: `UBFX-N3-${SALT}`, issueDate: daysAgo(40), currency: "NGN", grandTotal: "100000.00" }),
    // USD habit, same lateness: the MOST RECENT non-null rate (1500, on the
    // middle invoice — the newest carries none) sets the rank.
    fxRow({ buyerPartyId: buyerUsd, invoiceNumber: `UBFX-U1-${SALT}`, issueDate: daysAgo(100), currency: "USD", grandTotal: "2000.00", fxRateToNgn: "1300" }),
    fxRow({ buyerPartyId: buyerUsd, invoiceNumber: `UBFX-U2-${SALT}`, issueDate: daysAgo(70), currency: "USD", grandTotal: "2000.00", fxRateToNgn: "1500" }),
    fxRow({ buyerPartyId: buyerUsd, invoiceNumber: `UBFX-U3-${SALT}`, issueDate: daysAgo(40), currency: "USD", grandTotal: "2000.00" }),
    // EUR habit with no rate ever captured: unconvertible, ranks at face.
    fxRow({ buyerPartyId: buyerEur, invoiceNumber: `UBFX-E1-${SALT}`, issueDate: daysAgo(100), currency: "EUR", grandTotal: "900.00" }),
    fxRow({ buyerPartyId: buyerEur, invoiceNumber: `UBFX-E2-${SALT}`, issueDate: daysAgo(70), currency: "EUR", grandTotal: "900.00" }),
    fxRow({ buyerPartyId: buyerEur, invoiceNumber: `UBFX-E3-${SALT}`, issueDate: daysAgo(40), currency: "EUR", grandTotal: "900.00" }),
  ]);

  const alerts = await listUnbilledIncome(fxFirm, fxClient);
  assert.deepEqual(
    alerts.map((a) => a.currency),
    ["USD", "NGN", "EUR"],
    "USD 2,000 @ 1,500 (NGN 3,000,000) first, then NGN 100,000, then rate-less EUR 900 at face",
  );
  // Displayed amounts stay in the ORIGINAL currency — only the rank converts.
  assert.equal(Number(alerts[0].medianAmount), 2000);
  assert.equal(Number(alerts[1].medianAmount), 100_000);
  assert.equal(Number(alerts[2].medianAmount), 900);
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
