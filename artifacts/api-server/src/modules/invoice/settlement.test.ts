import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import {
  firmsTable,
  getDb,
  invoicesTable,
  partiesTable,
  settlementEventsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { appendSettlementEvent } from "./settlement";
import { DomainError } from "../errors";
import { makeRunSalt } from "../../test-helpers/fixtures";

const firmId = randomUUID();
const supplierId = randomUUID();
const buyerId = randomUUID();
const invoiceId = randomUUID();
const salt = makeRunSalt();

before(async () => {
  await getDb()
    .insert(firmsTable)
    .values({
      id: firmId,
      name: `Settlement Test Firm ${salt}`,
    });
  await getDb()
    .insert(partiesTable)
    .values([
      {
        id: supplierId,
        type: "client_business",
        legalName: `Settlement Supplier ${salt}`,
      },
      { id: buyerId, type: "buyer", legalName: `Settlement Buyer ${salt}` },
    ]);
  await getDb()
    .insert(invoicesTable)
    .values({
      id: invoiceId,
      firmId,
      supplierPartyId: supplierId,
      buyerPartyId: buyerId,
      invoiceNumber: `SET-${salt}`,
      kind: "invoice",
      issueDate: "2026-07-01",
      status: "stamped",
      grandTotal: "100.00",
    });
});

test("concurrent settlement retries create one event and return one identity", async () => {
  const externalReference = `test:${randomUUID()}`;
  const occurredAt = new Date("2026-07-05T12:00:00.000Z");
  const values = {
    invoiceId,
    source: "uploaded_evidence" as const,
    amount: "40.00",
    confidence: "0.9000",
    actorId: `actor-${salt}`,
    externalReference,
    occurredAt,
  };

  const results = await Promise.all([
    appendSettlementEvent(values),
    appendSettlementEvent(values),
  ]);
  assert.equal(results.filter((result) => result.created).length, 1);
  assert.equal(results[0].event.id, results[1].event.id);

  const rows = await getDb()
    .select()
    .from(settlementEventsTable)
    .where(eq(settlementEventsTable.externalReference, externalReference));
  assert.equal(rows.length, 1);
});

test("reusing a settlement key with different financial facts is a conflict", async () => {
  const externalReference = `test:${randomUUID()}`;
  const occurredAt = new Date("2026-07-06T12:00:00.000Z");
  await appendSettlementEvent({
    invoiceId,
    source: "uploaded_evidence",
    amount: "20.00",
    confidence: null,
    actorId: `actor-${salt}`,
    externalReference,
    occurredAt,
  });

  await assert.rejects(
    appendSettlementEvent({
      invoiceId,
      source: "uploaded_evidence",
      amount: "21.00",
      confidence: null,
      actorId: `actor-${salt}`,
      externalReference,
      occurredAt,
    }),
    (error: unknown) =>
      error instanceof DomainError && error.code === "IDEMPOTENCY_CONFLICT",
  );
});
