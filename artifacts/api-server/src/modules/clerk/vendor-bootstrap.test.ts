import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, invoicesTable, partiesTable } from "@workspace/db";
import { createExtractionCase, decideCase } from "./cases.ts";
import {
  ensureClerkFixtures,
  fakeGateway,
  restoreClerkFlag,
  saveAndEnableClerkFlag,
} from "./test-support.ts";
import { expectDomainError } from "../../test-helpers/assertions.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Vendor bootstrap (payables round): approving a case whose supplier is a
// BRAND-NEW vendor party — created by the firm, with no engagement and, by
// definition, no invoice yet — must pass assertPartyInFirm through the
// created_by_firm_id provenance arm. Before this arm the FIRST bill from any
// new vendor was un-approvable (PARTY_NOT_IN_FIRM); a party with no linkage
// at all still refuses.

const SALT = makeRunSalt();
// Fixed ids: clerk cases and the draft invoice an approval creates are
// append-only artifacts, so the users/parties they reference must persist
// (the clerk.test.ts convention).
const makerId = "cccc0011-0000-4000-8000-00000000cd01";
const checkerId = "cccc0012-0000-4000-8000-00000000cd02";
const firmId = "cccc0013-0000-4000-8000-00000000cd03";
const clientId = "cccc0014-0000-4000-8000-00000000cd04"; // engaged (the buyer of the bill)
const buyerId = "cccc0015-0000-4000-8000-00000000cd05";
const vendorId = randomUUID(); // firm-created, NO engagement, NO invoice
const strangerId = randomUUID(); // no linkage at all

before(async () => {
  await saveAndEnableClerkFlag();
  await ensureClerkFixtures({
    users: [
      { id: makerId, email: "vendor-bootstrap-maker@test.local" },
      { id: checkerId, email: "vendor-bootstrap-checker@test.local" },
    ],
    firmId,
    firmName: `Vendor Bootstrap Firm ${SALT}`,
    supplierId: clientId,
    supplierName: `VB Client ${SALT}`,
    buyerId,
    buyerName: `VB Buyer ${SALT}`,
    engagementTitle: `VB engagement ${SALT}`,
  });
  await getDb().insert(partiesTable).values([
    {
      id: vendorId,
      type: "buyer",
      legalName: `VB New Vendor ${SALT}`,
      createdByFirmId: firmId,
      createdByUserId: makerId,
    },
    { id: strangerId, type: "buyer", legalName: `VB Stranger ${SALT}` },
  ]);
});

after(async () => {
  await restoreClerkFlag();
});

const gateway = () =>
  fakeGateway(() => JSON.stringify({ fields: [], lines: [] }));

const approval = (supplierPartyId: string) => ({
  action: "approve" as const,
  firmId,
  supplierPartyId,
  buyerPartyId: clientId,
  invoiceNumber: `VB-${SALT}-${supplierPartyId.slice(0, 8)}`,
  issueDate: "2026-07-01",
  lines: [
    { description: "Cartons", quantity: "10", unitPrice: "1200", vatRate: "0.075" },
  ],
});

test("the first bill from a firm-created vendor approves via the provenance arm", async () => {
  const kase = await createExtractionCase(
    { sourceType: "text", text: `Vendor bill ${SALT}` },
    makerId,
    gateway(),
  );
  const decided = await decideCase(kase.id, approval(vendorId), checkerId);
  assert.equal(decided.status, "approved");
  assert.ok(decided.createdInvoiceId);
  const [invoice] = await getDb()
    .select()
    .from(invoicesTable)
    .where(eq(invoicesTable.id, decided.createdInvoiceId!));
  assert.equal(invoice.status, "draft", "approval stops at a draft, as ever");
  assert.equal(invoice.supplierPartyId, vendorId);
  assert.equal(invoice.buyerPartyId, clientId, "the engaged client is the buyer");
});

test("a party with no engagement, invoice or provenance still refuses", async () => {
  const kase = await createExtractionCase(
    { sourceType: "text", text: `Stranger bill ${SALT}` },
    makerId,
    gateway(),
  );
  await assert.rejects(
    decideCase(kase.id, approval(strangerId), checkerId),
    (err: unknown) => {
      expectDomainError(err, "PARTY_NOT_IN_FIRM", 400);
      return true;
    },
  );
});
