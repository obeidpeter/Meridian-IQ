import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  getDb,
  firmsTable,
  partiesTable,
  invoicesTable,
  stampRecordsTable,
  confirmationsTable,
} from "@workspace/db";
import {
  computeExposure,
  computeScoreboard,
  respondBulk,
  supplierDetail,
} from "./service.ts";
import { DomainError } from "../errors.ts";
import type { Principal } from "../auth/rbac.ts";
import { daysAgo, makeRunSalt } from "../../test-helpers/fixtures.ts";

// Supplier compliance scoreboard (BR-05). Pinned invariants:
//  - complianceScore = 0.6 × stamped rate + 0.4 × confirmed rate, where the
//    stamped rate counts only invoices that are stamped AND still
//    lifecycle-eligible (a cancelled stamped invoice is exposure, CORE-09);
//  - the LATEST confirmation row decides an invoice's confirmation state
//    (append-only lineage, newest wins);
//  - drafts / locally-validated invoices are the supplier firm's private
//    working state and never enter another organization's scoreboard;
//  - ranking is score, then volume, with rank assigned 1..n.

const SALT = makeRunSalt();

const firmId = randomUUID();
const buyerId = randomUUID();
const supplierOne = randomUUID(); // 4 visible invoices, 3 stamped, 2 confirmed
const supplierTwo = randomUUID(); // 2 visible invoices, none protected

async function seedInvoice(input: {
  id: string;
  supplierPartyId: string;
  status: string;
  vatTotal: string;
  stamped?: boolean;
}): Promise<void> {
  const db = getDb();
  await db.insert(invoicesTable).values({
    id: input.id,
    firmId,
    supplierPartyId: input.supplierPartyId,
    buyerPartyId: buyerId,
    invoiceNumber: `SB-${input.id.slice(0, 8)}-${SALT}`,
    issueDate: daysAgo(10),
    status: input.status as never,
    grandTotal: "1000.00",
    subtotal: "900.00",
    vatTotal: input.vatTotal,
  });
  if (input.stamped) {
    await db.insert(stampRecordsTable).values({
      invoiceId: input.id,
      irn: `IRN-${input.id.slice(0, 8)}-${SALT}`,
      csid: `CSID-${input.id.slice(0, 8)}-${SALT}`,
      qrPayload: "qr",
      signedArtifactRef: "artifact://test",
      rail: "rail_primary",
    });
  }
}

// Supplier one's book: I1/I2 confirmed, I3's latest response is a query, I4
// unstamped with an open request.
const i1 = randomUUID();
const i2 = randomUUID();
const i3 = randomUUID();
const i4 = randomUUID();
// Supplier two's book: an unstamped submitted invoice and a stamped-then-
// cancelled one (stamped but NOT eligible).
const i5 = randomUUID();
const i6 = randomUUID();

before(async () => {
  const db = getDb();
  await db.insert(firmsTable).values({ id: firmId, name: `SB Firm ${SALT}` });
  await db.insert(partiesTable).values([
    { id: buyerId, type: "buyer", legalName: `SB Buyer ${SALT}` },
    {
      id: supplierOne,
      type: "client_business",
      legalName: `SB Supplier One ${SALT}`,
    },
    {
      id: supplierTwo,
      type: "client_business",
      legalName: `SB Supplier Two ${SALT}`,
    },
  ]);

  await seedInvoice({ id: i1, supplierPartyId: supplierOne, status: "stamped", vatTotal: "100.00", stamped: true });
  await seedInvoice({ id: i2, supplierPartyId: supplierOne, status: "confirmed", vatTotal: "100.00", stamped: true });
  await seedInvoice({ id: i3, supplierPartyId: supplierOne, status: "stamped", vatTotal: "100.00", stamped: true });
  await seedInvoice({ id: i4, supplierPartyId: supplierOne, status: "submitted", vatTotal: "100.00" });
  await seedInvoice({ id: i5, supplierPartyId: supplierTwo, status: "submitted", vatTotal: "50.00" });
  await seedInvoice({ id: i6, supplierPartyId: supplierTwo, status: "cancelled", vatTotal: "70.00", stamped: true });
  // A draft addressed to the buyer must never surface outside its firm.
  await seedInvoice({ id: randomUUID(), supplierPartyId: supplierOne, status: "draft", vatTotal: "100.00" });

  // Append-only confirmation lineage; the newest row per invoice decides.
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);
  await db.insert(confirmationsTable).values([
    // I1: requested, then confirmed — counts as confirmed.
    { invoiceId: i1, buyerPartyId: buyerId, state: "requested", createdAt: at(60) },
    { invoiceId: i1, buyerPartyId: buyerId, state: "confirmed", method: "portal", createdAt: at(30) },
    // I2: confirmed outright.
    { invoiceId: i2, buyerPartyId: buyerId, state: "confirmed", method: "portal", createdAt: at(45) },
    // I3: confirmed EARLIER, then queried — the newer query wins.
    { invoiceId: i3, buyerPartyId: buyerId, state: "confirmed", method: "portal", createdAt: at(50) },
    { invoiceId: i3, buyerPartyId: buyerId, state: "queried", method: "portal", note: "price?", createdAt: at(20) },
    // I4: open request — outstanding.
    { invoiceId: i4, buyerPartyId: buyerId, state: "requested", createdAt: at(10) },
  ]);
});

test("computeScoreboard weights stamped 0.6 and confirmed 0.4 over the visible book", async () => {
  const entries = await computeScoreboard(buyerId);
  assert.equal(entries.length, 2, "drafts create no scoreboard supplier");

  const one = entries.find((e) => e.supplierPartyId === supplierOne);
  const two = entries.find((e) => e.supplierPartyId === supplierTwo);
  assert.ok(one && two);

  // Supplier one: 4 visible invoices (the draft is invisible), 3 stamped and
  // eligible, 2 whose latest confirmation is `confirmed`.
  assert.equal(one.invoiceCount, 4);
  assert.equal(one.stampedRate, 0.75);
  assert.equal(one.confirmedRate, 0.5);
  // 0.6 × 0.75 + 0.4 × 0.5, rounded to 3 dp exactly as the service does.
  assert.equal(
    one.complianceScore,
    Math.round((0.6 * 0.75 + 0.4 * 0.5) * 1000) / 1000, // 0.65
  );
  assert.equal(one.confirmedCount, 2);
  assert.equal(one.outstandingCount, 1, "the open request on I4");
  assert.equal(one.queriedCount, 1, "I3's newest lineage row is the query");
  assert.equal(one.vatAtRisk, "100.00", "only the unstamped I4's VAT");

  // Supplier two: nothing protected — the cancelled invoice is stamped but no
  // longer eligible, so its VAT is exposure, not protection.
  assert.equal(two.invoiceCount, 2);
  assert.equal(two.stampedRate, 0);
  assert.equal(two.confirmedRate, 0);
  assert.equal(two.complianceScore, 0);
  assert.equal(two.vatAtRisk, "120.00");

  // Ranked by score.
  assert.equal(one.rank, 1);
  assert.equal(two.rank, 2);

  // A foreign buyer party sees an empty scoreboard.
  assert.deepEqual(await computeScoreboard(randomUUID()), []);
});

test("supplierDetail: the drill-down runs the exposure breakdown's aggregation and scopes to the caller's book", async () => {
  const detail = await supplierDetail(buyerId, supplierOne);

  // Same numbers as the exposure breakdown entry — one aggregation, two
  // surfaces.
  const exposure = await computeExposure(buyerId);
  const breakdownEntry = exposure.breakdown.find(
    (b) => b.supplierPartyId === supplierOne,
  );
  assert.deepEqual(detail.supplier, breakdownEntry);
  assert.equal(detail.supplier.supplierName, `SB Supplier One ${SALT}`);
  assert.equal(detail.supplier.invoiceCount, 4, "the draft is invisible");
  assert.equal(detail.supplier.stampedCount, 3);
  assert.equal(detail.supplier.eligibleCount, 3);
  assert.equal(detail.supplier.totalAmount, "4000.00");
  assert.equal(detail.supplier.vatProtected, "300.00");
  assert.equal(detail.supplier.vatAtRisk, "100.00", "only the unstamped I4");

  // The invoice rows carry the latest-lineage confirmation state and stamp
  // facts, and belong exclusively to this supplier.
  assert.equal(detail.invoices.length, 4);
  assert.ok(detail.invoices.every((i) => i.supplierPartyId === supplierOne));
  const byId = new Map(detail.invoices.map((i) => [i.id, i]));
  assert.equal(byId.get(i1)?.confirmationState, "confirmed");
  assert.equal(byId.get(i3)?.confirmationState, "queried", "newest lineage row wins");
  assert.equal(byId.get(i4)?.confirmationState, "requested");
  assert.equal(byId.get(i4)?.stampValid, false);
  assert.equal(byId.get(i1)?.eligible, true);

  // No invoices to the caller = 404: an unknown supplier, and equally a
  // real supplier viewed by a buyer it never invoiced.
  await assert.rejects(supplierDetail(buyerId, randomUUID()), (err: unknown) => {
    assert.ok(err instanceof DomainError);
    assert.equal(err.status, 404);
    return true;
  });
  await assert.rejects(supplierDetail(randomUUID(), supplierOne), (err: unknown) => {
    assert.ok(err instanceof DomainError);
    assert.equal(err.status, 404);
    return true;
  });
});

test("respondBulk refuses an over-cap batch outright", async () => {
  const buyerPrincipal: Principal = {
    userId: randomUUID(),
    role: "buyer_user",
    firmId: null,
    clientPartyId: null,
    buyerPartyId: buyerId,
  };
  await assert.rejects(
    respondBulk(
      buyerPrincipal,
      Array.from({ length: 51 }, () => randomUUID()),
      "portal",
      false,
    ),
    (err: unknown) => {
      assert.ok(err instanceof DomainError);
      assert.equal(err.status, 400);
      return true;
    },
  );
});
