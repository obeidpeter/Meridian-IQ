import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  getDb,
  firmsTable,
  partiesTable,
  invoicesTable,
  invoiceLinesTable,
  usersTable,
  recurringInvoiceTemplatesTable,
} from "@workspace/db";
import {
  detectMonthlyPattern,
  listRecurringSuggestions,
} from "./recurring-suggest.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Recurring-invoice suggestions (exhaust idea #3). Pinned invariants:
//  - detection is pure and conservative: three-ish monthly invoices with
//  clustered amounts; anything thinner or faster stays silent;
//  - a buyer already covered by ANY template (active or paused) is never
//  re-suggested;
//  - the suggestion's seed lines come from the newest invoice in the pattern;
//  - nothing is stored — the client saves through the ordinary template path.

const SALT = makeRunSalt();
const firmId = randomUUID();
const clientId = randomUUID();
const buyerMonthly = randomUUID();
const buyerSparse = randomUUID();
const buyerCovered = randomUUID();
const userId = randomUUID();

// Recent Lagos-ish dates, oldest to newest, roughly monthly.
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

const row = (over: {
  id?: string;
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
  grandTotal: over.grandTotal ?? "150000.00",
  subtotal: "139534.88",
  vatTotal: "10465.12",
  ...(over.id ? { id: over.id } : {}),
});

const newestMonthlyId = randomUUID();

before(async () => {
  const db = getDb();
  await db.insert(firmsTable).values({ id: firmId, name: `RS Firm ${SALT}` });
  await db
    .insert(usersTable)
    .values({ id: userId, email: `rs-${SALT}@test.example` })
    .onConflictDoNothing();
  await db.insert(partiesTable).values([
    { id: clientId, type: "client_business", legalName: `RS Client ${SALT}` },
    { id: buyerMonthly, type: "buyer", legalName: `RS Monthly Buyer ${SALT}` },
    { id: buyerSparse, type: "buyer", legalName: `RS Sparse Buyer ${SALT}` },
    { id: buyerCovered, type: "buyer", legalName: `RS Covered Buyer ${SALT}` },
  ]);
  await db.insert(invoicesTable).values([
    // A clean monthly pattern: three invoices ~30 days apart, same amount.
    row({ buyerPartyId: buyerMonthly, invoiceNumber: `RS-M1-${SALT}`, issueDate: daysAgo(75) }),
    row({ buyerPartyId: buyerMonthly, invoiceNumber: `RS-M2-${SALT}`, issueDate: daysAgo(45) }),
    row({
      id: newestMonthlyId,
      buyerPartyId: buyerMonthly,
      invoiceNumber: `RS-M3-${SALT}`,
      issueDate: daysAgo(15),
    }),
    // Too thin to be a pattern.
    row({ buyerPartyId: buyerSparse, invoiceNumber: `RS-S1-${SALT}`, issueDate: daysAgo(60) }),
    row({ buyerPartyId: buyerSparse, invoiceNumber: `RS-S2-${SALT}`, issueDate: daysAgo(30) }),
    // A perfect pattern — but the buyer already has a (paused) template.
    row({ buyerPartyId: buyerCovered, invoiceNumber: `RS-C1-${SALT}`, issueDate: daysAgo(75) }),
    row({ buyerPartyId: buyerCovered, invoiceNumber: `RS-C2-${SALT}`, issueDate: daysAgo(45) }),
    row({ buyerPartyId: buyerCovered, invoiceNumber: `RS-C3-${SALT}`, issueDate: daysAgo(15) }),
  ]);
  // Seed lines on the newest monthly invoice — the suggestion's template seed.
  await db.insert(invoiceLinesTable).values([
    {
      invoiceId: newestMonthlyId,
      lineNo: 1,
      description: `Monthly retainer ${SALT}`,
      quantity: "1",
      unitPrice: "139534.88",
      vatRate: "0.075",
      lineExtension: "139534.88",
      vatAmount: "10465.12",
    },
  ]);
  await db.insert(recurringInvoiceTemplatesTable).values({
    firmId,
    supplierPartyId: clientId,
    buyerPartyId: buyerCovered,
    name: `Covered ${SALT}`,
    cadence: "monthly",
    nextRunDate: daysAgo(0),
    active: false, // paused STILL counts as covered
    lines: [
      { description: "x", quantity: "1", unitPrice: "1", vatRate: "0.075" },
    ],
    createdByUserId: userId,
  });
});

test("detectMonthlyPattern is conservative and pure", () => {
  const inv = (issueDate: string, grandTotal = 150000) => ({
    id: randomUUID(),
    issueDate,
    grandTotal,
  });
  // Three monthly invoices with equal amounts: a pattern.
  const hit = detectMonthlyPattern([
    inv("2026-03-01"),
    inv("2026-04-02"),
    inv("2026-05-01"),
  ]);
  assert.ok(hit);
  assert.equal(hit.count, 3);
  assert.equal(hit.medianAmount, 150000);
  assert.equal(hit.lastIssueDate, "2026-05-01");

  // Two invoices: silence.
  assert.equal(detectMonthlyPattern([inv("2026-03-01"), inv("2026-04-01")]), null);
  // Weekly cadence: not a monthly retainer.
  assert.equal(
    detectMonthlyPattern([
      inv("2026-03-01"),
      inv("2026-03-08"),
      inv("2026-03-15"),
      inv("2026-03-22"),
    ]),
    null,
  );
  // Amounts all over the place: no standing arrangement.
  assert.equal(
    detectMonthlyPattern([
      inv("2026-03-01", 10000),
      inv("2026-04-02", 500000),
      inv("2026-05-01", 90),
    ]),
    null,
  );

  // Same-day burst: three invoices on one day + one two months later is TWO
  // billing events, not monthly — the zero-day gaps must not fake a cadence.
  assert.equal(
    detectMonthlyPattern([
      inv("2026-03-01"),
      inv("2026-03-01"),
      inv("2026-03-01"),
      inv("2026-05-05"),
    ]),
    null,
  );
});

test("suggestions cover the pattern, skip thin history and covered buyers", async () => {
  const suggestions = await listRecurringSuggestions(firmId, clientId);
  assert.equal(suggestions.length, 1, "exactly the monthly buyer");
  const s = suggestions[0];
  assert.equal(s.buyerPartyId, buyerMonthly);
  assert.equal(s.buyerName, `RS Monthly Buyer ${SALT}`);
  assert.equal(s.count, 3);
  assert.equal(Number(s.medianAmount), 150000);
  // Seed lines are the NEWEST invoice's lines, normalised for the form.
  assert.equal(s.lines.length, 1);
  assert.equal(s.lines[0].description, `Monthly retainer ${SALT}`);
  assert.equal(s.lines[0].vatRate, "0.075");
  assert.equal(s.lines[0].unitPrice, "139534.88");
});

test("another firm or another client sees nothing", async () => {
  const foreignFirm = await listRecurringSuggestions(randomUUID(), clientId);
  assert.equal(foreignFirm.length, 0);
  const foreignClient = await listRecurringSuggestions(firmId, randomUUID());
  assert.equal(foreignClient.length, 0);
});
