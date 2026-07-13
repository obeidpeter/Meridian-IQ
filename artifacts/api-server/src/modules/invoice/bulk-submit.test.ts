import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  getDb,
  firmsTable,
  partiesTable,
  engagementsTable,
  usersTable,
  invoicesTable,
  auditEventsTable,
} from "@workspace/db";
import { sql } from "drizzle-orm";
import { DomainError } from "../errors.ts";
import { recordConsent } from "../consent/consent.ts";
import { createDraft, validateInvoice } from "./service.ts";
import { bulkSubmit } from "./bulk-submit.ts";

// Bulk validate & submit. The batch must behave exactly like N single
// submits: consent gate up front, validation failures reported per row (and
// the draft left untouched), successful rows transitioned and enqueued, the
// batch bounded with an honest `remaining`. Fixtures are salted per run —
// submitted invoices are immutable and persist in the shared database.

const SALT = `${Date.now().toString(36)}${process.pid}`;

const firmId = randomUUID();
const userId = randomUUID();
const supplier = randomUUID(); // complete + consented
// Own supplier for the batching test: the invalid draft left by the mixed
// batch stays pending by design (the operator must fix it), so it would
// otherwise re-enter — and reorder — a shared oldest-first queue.
const supplierBatch = randomUUID(); // complete + consented
const supplierNoConsent = randomUUID(); // complete, NO consent
const buyer = randomUUID(); // complete
const buyerNoTin = randomUUID(); // incomplete: fails canonical validation

const LINE = {
  description: "Goods",
  quantity: "1",
  unitPrice: "1000",
  vatRate: "0.075",
};

let n = 0;
function draftFor(
  supplierPartyId: string,
  buyerPartyId: string,
): Promise<{ invoice: { id: string; invoiceNumber: string } }> {
  n += 1;
  return createDraft(
    {
      firmId,
      supplierPartyId,
      buyerPartyId,
      invoiceNumber: `BULK-${SALT}-${n}`,
      issueDate: "2026-07-01",
      dueDate: null,
      lines: [LINE],
    },
    userId,
  );
}

before(async () => {
  const db = getDb();
  await db
    .insert(usersTable)
    .values({ id: userId, email: `bulk-${SALT}@test.local` })
    .onConflictDoNothing();
  await db.insert(firmsTable).values({ id: firmId, name: `Bulk Firm ${SALT}` });
  await db.insert(partiesTable).values([
    {
      id: supplier,
      type: "client_business",
      legalName: `Bulk Supplier ${SALT}`,
      tin: "10000000-0001",
      street: "1 Marina Rd",
      city: "Lagos",
    },
    {
      id: supplierBatch,
      type: "client_business",
      legalName: `Bulk Batch Supplier ${SALT}`,
      tin: "10000000-0003",
      street: "4 Marina Rd",
      city: "Lagos",
    },
    {
      id: supplierNoConsent,
      type: "client_business",
      legalName: `Bulk Unconsented ${SALT}`,
      tin: "10000000-0002",
      street: "2 Marina Rd",
      city: "Lagos",
    },
    {
      id: buyer,
      type: "buyer",
      legalName: `Bulk Buyer ${SALT}`,
      tin: "20000000-0001",
      street: "3 Broad St",
      city: "Lagos",
    },
    {
      // No TIN/street/city: any invoice naming this buyer fails canonical
      // validation — the deterministic "invalid" fixture.
      id: buyerNoTin,
      type: "buyer",
      legalName: `Bulk Incomplete Buyer ${SALT}`,
    },
  ]);
  await db.insert(engagementsTable).values([
    { firmId, clientPartyId: supplier, type: "readiness_assessment", title: "bulk A" },
    { firmId, clientPartyId: supplierBatch, type: "readiness_assessment", title: "bulk C" },
    { firmId, clientPartyId: supplierNoConsent, type: "readiness_assessment", title: "bulk B" },
  ]);
  // Layer-1 compliance consent for the submitting suppliers only.
  for (const partyId of [supplier, supplierBatch]) {
    await recordConsent({
      partyId,
      layer: 1,
      action: "grant",
      scope: "compliance",
      basis: "contract",
      channel: "test",
      actorId: userId,
    });
  }
});

test("a mixed batch submits the valid drafts and reports the invalid ones", async () => {
  const good1 = await draftFor(supplier, buyer);
  const bad = await draftFor(supplier, buyerNoTin);
  const good2 = await draftFor(supplier, buyer);

  const result = await bulkSubmit(supplier, firmId, userId);
  assert.equal(result.total, 3);
  assert.equal(result.submittedCount, 2);
  assert.equal(result.invalidCount, 1);
  assert.equal(result.failedCount, 0);
  assert.equal(result.remaining, 0);

  // Oldest first: creation order is preserved in the rows.
  assert.deepEqual(
    result.rows.map((r) => r.invoiceId),
    [good1.invoice.id, bad.invoice.id, good2.invoice.id],
  );

  const invalidRow = result.rows.find((r) => r.invoiceId === bad.invoice.id)!;
  assert.equal(invalidRow.outcome, "invalid");
  assert.ok(invalidRow.errors.length > 0, "validation errors are reported");

  const db = getDb();
  const statusOf = async (id: string) =>
    (
      await db
        .select({ status: invoicesTable.status })
        .from(invoicesTable)
        .where(eq(invoicesTable.id, id))
    )[0]!.status;
  assert.equal(await statusOf(good1.invoice.id), "submitted");
  assert.equal(await statusOf(good2.invoice.id), "submitted");
  assert.equal(
    await statusOf(bad.invoice.id),
    "draft",
    "an invalid draft is reported, not touched",
  );

  // The batch itself is audited with its tallies.
  const [auditRow] = await db
    .select()
    .from(auditEventsTable)
    .where(eq(auditEventsTable.action, "invoice.bulk_submit"))
    .orderBy(sql`${auditEventsTable.seq} DESC`)
    .limit(1);
  assert.ok(auditRow);
});

test("already-validated invoices are submitted without re-validation", async () => {
  const { invoice } = await draftFor(supplier, buyer);
  const validation = await validateInvoice(invoice.id, userId);
  assert.equal(validation.ok, true);

  const result = await bulkSubmit(supplier, firmId, userId);
  const row = result.rows.find((r) => r.invoiceId === invoice.id);
  assert.equal(row?.outcome, "submitted");
});

test("the batch is bounded and reports what remains, oldest first", async () => {
  const a = await draftFor(supplierBatch, buyer);
  const b = await draftFor(supplierBatch, buyer);
  const c = await draftFor(supplierBatch, buyer);

  const first = await bulkSubmit(supplierBatch, firmId, userId, 2);
  assert.equal(first.total, 2);
  assert.deepEqual(
    first.rows.map((r) => r.invoiceId),
    [a.invoice.id, b.invoice.id],
    "the two OLDEST pending drafts go first",
  );
  assert.equal(first.remaining, 1);

  const second = await bulkSubmit(supplierBatch, firmId, userId, 2);
  assert.equal(second.total, 1);
  assert.equal(second.rows[0]?.invoiceId, c.invoice.id);
  assert.equal(second.remaining, 0);

  const third = await bulkSubmit(supplierBatch, firmId, userId);
  assert.equal(third.total, 0, "an empty queue is an empty batch, not an error");
});

test("a supplier without layer-1 consent is refused up front", async () => {
  await draftFor(supplierNoConsent, buyer);
  await assert.rejects(
    bulkSubmit(supplierNoConsent, firmId, userId),
    (e: unknown) =>
      e instanceof DomainError &&
      e.code === "CONSENT_REQUIRED" &&
      e.status === 403,
  );
  // The draft was never touched.
  const [row] = await getDb()
    .select({ status: invoicesTable.status })
    .from(invoicesTable)
    .where(eq(invoicesTable.supplierPartyId, supplierNoConsent));
  assert.equal(row.status, "draft");
});
