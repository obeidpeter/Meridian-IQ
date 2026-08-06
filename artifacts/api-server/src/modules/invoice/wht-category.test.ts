import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, firmsTable, invoicesTable, partiesTable } from "@workspace/db";
import { createDraft, updateInvoiceContent } from "./service.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// whtCategory threading (WHT Desk): the invoice write paths persist the
// HUMAN-assigned withholding category — create sets it, PATCH replaces it, a
// null PATCH clears it, an absent field leaves it untouched (the fxRateToNgn
// tri-state). Bills are invoices, so the same path covers both orientations.

const SALT = makeRunSalt();
const firmId = randomUUID();
const supplierParty = randomUUID();
const buyerParty = randomUUID();

before(async () => {
  const db = getDb();
  await db.insert(firmsTable).values({ id: firmId, name: `WHT Cat Firm ${SALT}` });
  await db.insert(partiesTable).values([
    { id: supplierParty, type: "client_business", legalName: `WHT Cat Client ${SALT}` },
    { id: buyerParty, type: "buyer", legalName: `WHT Cat Buyer ${SALT}` },
  ]);
});

test("create persists the category; PATCH replaces, leaves and clears it", async () => {
  const { invoice } = await createDraft({
    firmId,
    supplierPartyId: supplierParty,
    buyerPartyId: buyerParty,
    invoiceNumber: `WCAT-${SALT}`,
    issueDate: "2026-07-01",
    whtCategory: "services_5",
    lines: [
      { description: "Advisory", quantity: "1", unitPrice: "100000.00", vatRate: "0.075" },
    ],
  });
  assert.equal(invoice.whtCategory, "services_5");

  // PATCH to another category.
  const changed = await updateInvoiceContent(invoice.id, {
    whtCategory: "rent_10",
  });
  assert.equal(changed.invoice.whtCategory, "rent_10");

  // An absent field leaves the category untouched.
  const untouched = await updateInvoiceContent(invoice.id, {
    notes: "no category in this patch",
  });
  assert.equal(untouched.invoice.whtCategory, "rent_10");

  // Null clears it.
  const cleared = await updateInvoiceContent(invoice.id, { whtCategory: null });
  assert.equal(cleared.invoice.whtCategory, null);
  const [row] = await getDb()
    .select({ whtCategory: invoicesTable.whtCategory })
    .from(invoicesTable)
    .where(eq(invoicesTable.id, invoice.id));
  assert.equal(row.whtCategory, null);
});

test("create without a category stores null — no WHT applies by default", async () => {
  const { invoice } = await createDraft({
    firmId,
    supplierPartyId: supplierParty,
    buyerPartyId: buyerParty,
    invoiceNumber: `WCAT-NONE-${SALT}`,
    issueDate: "2026-07-01",
    lines: [
      { description: "Goods", quantity: "1", unitPrice: "5000.00", vatRate: "0.075" },
    ],
  });
  assert.equal(invoice.whtCategory, null);
});
