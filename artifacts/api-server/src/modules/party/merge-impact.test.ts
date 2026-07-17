import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  getDb,
  runInBypassContext,
  firmsTable,
  partiesTable,
  invoicesTable,
  usersTable,
  engagementsTable,
  partyNameAliasesTable,
  recurringInvoiceTemplatesTable,
} from "@workspace/db";
import { computeMergeImpact } from "./merge-impact.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Merge impact preview (round-12 idea #2). Counts are per-party FK
// references — exact, since the seeded parties are unique to this test.

const SALT = makeRunSalt();
const firmId = randomUUID();
const heavyId = randomUUID();
const lightId = randomUUID();
const buyerId = randomUUID();
const userId = randomUUID();

before(async () => {
  const db = getDb();
  await db.insert(firmsTable).values({ id: firmId, name: `MI Firm ${SALT}` });
  await db
    .insert(usersTable)
    .values({ id: userId, email: `mi-${SALT}@test.example` })
    .onConflictDoNothing();
  await db.insert(partiesTable).values([
    { id: heavyId, type: "client_business", legalName: `MI Heavy ${SALT}` },
    { id: lightId, type: "client_business", legalName: `MI Light ${SALT}` },
    { id: buyerId, type: "buyer", legalName: `MI Buyer ${SALT}` },
  ]);
  await db.insert(invoicesTable).values([
    {
      firmId,
      supplierPartyId: heavyId,
      buyerPartyId: buyerId,
      invoiceNumber: `MI-1-${SALT}`,
      issueDate: "2026-07-01",
    },
    {
      firmId,
      supplierPartyId: heavyId,
      buyerPartyId: buyerId,
      invoiceNumber: `MI-2-${SALT}`,
      issueDate: "2026-07-02",
    },
  ]);
  await db.insert(engagementsTable).values({
    firmId,
    clientPartyId: heavyId,
    type: "retainer",
    title: `MI engagement ${SALT}`,
  });
  await db.insert(recurringInvoiceTemplatesTable).values({
    firmId,
    supplierPartyId: heavyId,
    buyerPartyId: buyerId,
    name: `MI template ${SALT}`,
    cadence: "monthly",
    nextRunDate: "2026-08-01",
    active: true,
    lines: [
      { description: "x", quantity: "1", unitPrice: "1", vatRate: "0.075" },
    ],
    createdByUserId: userId,
  });
  // Aliases are firm-keyed RLS (migration 0017) — seed in bypass, the same
  // context the preview's operator caller runs in.
  await runInBypassContext(() =>
    getDb().insert(partyNameAliasesTable).values({
      firmId,
      partyId: heavyId,
      alias: `MI-ALIAS-${SALT.toUpperCase()}`,
    }),
  );
});

test("each side reports exactly what it carries; a missing party is null", async () => {
  const impact = await runInBypassContext(() =>
    computeMergeImpact(heavyId, lightId),
  );
  assert.ok(impact.survivor && impact.duplicate);
  assert.equal(impact.survivor.legalName, `MI Heavy ${SALT}`);
  assert.equal(impact.survivor.invoicesAsSupplier, 2);
  assert.equal(impact.survivor.invoicesAsBuyer, 0);
  assert.equal(impact.survivor.engagements, 1);
  assert.equal(impact.survivor.recurringTemplates, 1);
  assert.equal(impact.survivor.aliases, 1);
  assert.equal(impact.survivor.merged, false);

  assert.equal(impact.duplicate.legalName, `MI Light ${SALT}`);
  assert.equal(impact.duplicate.invoicesAsSupplier, 0);
  assert.equal(impact.duplicate.engagements, 0);

  // The buyer side of the same invoices counts under the buyer party.
  const buyerImpact = await runInBypassContext(() =>
    computeMergeImpact(buyerId, buyerId),
  );
  assert.equal(buyerImpact.survivor?.invoicesAsBuyer, 2);
  assert.equal(buyerImpact.survivor?.recurringTemplates, 1);

  const missing = await runInBypassContext(() =>
    computeMergeImpact(randomUUID(), heavyId),
  );
  assert.equal(missing.survivor, null);
  assert.ok(missing.duplicate);
});
