import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  getDb,
  firmsTable,
  partiesTable,
  invoicesTable,
  submissionAttemptsTable,
  errorCatalogueTable,
} from "@workspace/db";
import { computeRejectionRisk } from "./rejection-risk.ts";
import invoicesRouter from "../../routes/invoices.ts";
import type { Principal } from "../auth/rbac.ts";
import {
  appFor,
  listen,
  closeAllServers,
} from "../../test-helpers/route-harness.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Draft-time rejection risk. Pinned invariants:
//  - scoping: supplier/buyer signals come from THIS invoice's parties; the
//    firm scope carries the rest and never repeats a surfaced code (dedupe);
//  - the invoice's own attempts count (history is history);
//  - only rejected attempts inside the 90-day window count;
//  - catalogue grounding rides along when mapped; a null rail code folds to
//    'UNMAPPED' with null grounding;
//  - another firm's rejections never leak in;
//  - route: same load/scope gate as GET /invoices/:id — 404 unknown, 403 for
//    a sibling client_user and for a cross-firm principal (SEC-03).

const SALT = makeRunSalt();
const CODE_A = `RR_MAPPED_${SALT.toUpperCase()}`; // catalogue-mapped
const CODE_B = `RR_BUYER_${SALT.toUpperCase()}`; // unmapped
const CODE_C = `RR_FIRM_${SALT.toUpperCase()}`; // unmapped, firm-only

const firmA = randomUUID();
const firmB = randomUUID();
const supplier1 = randomUUID();
const supplier2 = randomUUID();
const buyerX = randomUUID();
const buyerY = randomUUID();
const clientB = randomUUID();

// The invoice under test: firm A, supplier1 → buyerX.
let inv1 = "";
let invB = "";

const DAY = 86_400_000;
const threeDaysAgo = new Date(Date.now() - 3 * DAY);

const firmAdmin: Principal = {
  userId: randomUUID(),
  role: "firm_admin",
  firmId: firmA,
  clientPartyId: null,
  buyerPartyId: null,
};
const clientS1: Principal = {
  userId: randomUUID(),
  role: "client_user",
  firmId: firmA,
  clientPartyId: supplier1,
  buyerPartyId: null,
};
const clientS2: Principal = { ...clientS1, userId: randomUUID(), clientPartyId: supplier2 };
const adminB: Principal = { ...firmAdmin, userId: randomUUID(), firmId: firmB };

before(async () => {
  const db = getDb();
  await db.insert(firmsTable).values([
    { id: firmA, name: `RR Firm A ${SALT}` },
    { id: firmB, name: `RR Firm B ${SALT}` },
  ]);
  await db.insert(partiesTable).values([
    { id: supplier1, type: "client_business", legalName: `RR Supplier 1 ${SALT}` },
    { id: supplier2, type: "client_business", legalName: `RR Supplier 2 ${SALT}` },
    { id: buyerX, type: "buyer", legalName: `RR Buyer X ${SALT}` },
    { id: buyerY, type: "buyer", legalName: `RR Buyer Y ${SALT}` },
    { id: clientB, type: "client_business", legalName: `RR Client B ${SALT}` },
  ]);
  await db
    .insert(errorCatalogueTable)
    .values({
      code: CODE_A,
      category: "identity",
      cause: `rr cause ${SALT}`,
      fix: `rr fix ${SALT}`,
      retriable: true,
    })
    .onConflictDoNothing();

  const mkInvoice = async (
    firmId: string,
    supplier: string,
    buyer: string,
    n: string,
  ) => {
    const id = randomUUID();
    await db.insert(invoicesTable).values({
      id,
      firmId,
      supplierPartyId: supplier,
      buyerPartyId: buyer,
      invoiceNumber: n,
      issueDate: "2026-07-01",
      status: "failed" as never,
    });
    return id;
  };
  // Append-only table: backdating happens at INSERT time.
  const attempt = async (
    invoiceId: string,
    no: number,
    status: string,
    errorCode: string | null,
    agoDays: number,
  ) => {
    await getDb().insert(submissionAttemptsTable).values({
      invoiceId,
      rail: "rail_primary",
      attemptNo: no,
      idempotencyKey: `rr-${invoiceId}-${no}`,
      status: status as never,
      errorCode,
      createdAt: new Date(Date.now() - agoDays * DAY),
    });
  };

  inv1 = await mkInvoice(firmA, supplier1, buyerX, `RR-1-${SALT}`);
  const inv1b = await mkInvoice(firmA, supplier1, buyerY, `RR-1b-${SALT}`);
  const invS2 = await mkInvoice(firmA, supplier2, buyerX, `RR-S2-${SALT}`);
  const invS2b = await mkInvoice(firmA, supplier2, buyerY, `RR-S2b-${SALT}`);
  invB = await mkInvoice(firmB, clientB, buyerX, `RR-B-${SALT}`);

  // Supplier1 history (includes THIS invoice's own attempts — kept):
  // CODE_A ×3 in-window; the 3-day-ago attempt is the scope's last sighting.
  await attempt(inv1, 1, "rejected", CODE_A, 5);
  await attempt(inv1, 2, "rejected", CODE_A, 3);
  await attempt(inv1b, 1, "rejected", CODE_A, 10);
  // Outside the 90-day window: ignored entirely.
  await attempt(inv1, 3, "rejected", CODE_A, 100);
  // Accepted attempts are not rejections, whatever code they carry.
  await attempt(inv1, 4, "accepted", CODE_B, 1);
  // BuyerX history via another supplier: CODE_B ×1.
  await attempt(invS2, 1, "rejected", CODE_B, 7);
  // Firm-wide residue (neither supplier1 nor buyerX): CODE_C ×2 + one
  // null-code rejection that must fold to UNMAPPED.
  await attempt(invS2b, 1, "rejected", CODE_C, 8);
  await attempt(invS2b, 2, "rejected", CODE_C, 6);
  await attempt(invS2b, 3, "rejected", null, 4);
  // Another firm's rejection with the shared code: invisible to firm A.
  await attempt(invB, 1, "rejected", CODE_A, 4);
});

after(async () => {
  await closeAllServers();
});

test("scopes, dedupe, window, catalogue grounding and UNMAPPED fold", async () => {
  const report = await computeRejectionRisk({
    id: inv1,
    firmId: firmA,
    supplierPartyId: supplier1,
    buyerPartyId: buyerX,
  });

  assert.equal(report.windowDays, 90);
  // 3 CODE_A + 1 CODE_B + 2 CODE_C + 1 UNMAPPED; the 100-day-old attempt,
  // the accepted attempt and firm B's rejection all excluded.
  assert.equal(report.totalRejections, 7);

  const supplier = report.signals.filter((s) => s.scope === "supplier");
  const buyer = report.signals.filter((s) => s.scope === "buyer");
  const firm = report.signals.filter((s) => s.scope === "firm");

  assert.deepEqual(
    supplier.map((s) => [s.errorCode, s.count]),
    [[CODE_A, 3]],
    "supplier scope: this supplier's codes only, window applied",
  );
  assert.deepEqual(
    buyer.map((s) => [s.errorCode, s.count]),
    [
      [CODE_A, 2],
      [CODE_B, 1],
    ],
    "buyer scope: this buyer's codes, count desc (own attempts kept)",
  );
  assert.deepEqual(
    firm.map((s) => [s.errorCode, s.count]),
    [
      [CODE_C, 2],
      ["UNMAPPED", 1],
    ],
    "firm scope: residue only — surfaced codes deduped out, null folds to UNMAPPED",
  );

  // Ordering: supplier → buyer → firm.
  assert.deepEqual(
    report.signals.map((s) => s.scope),
    ["supplier", "buyer", "buyer", "firm", "firm"],
  );

  // Catalogue grounding rides along on the mapped code, in every scope.
  assert.equal(supplier[0].cause, `rr cause ${SALT}`);
  assert.equal(supplier[0].fix, `rr fix ${SALT}`);
  assert.equal(supplier[0].category, "identity");
  assert.equal(supplier[0].retriable, true);
  assert.equal(buyer[0].cause, `rr cause ${SALT}`);
  // Unmapped codes report with null grounding.
  assert.equal(buyer[1].cause, null);
  assert.equal(firm[1].errorCode, "UNMAPPED");
  assert.equal(firm[1].category, null);
  assert.equal(firm[1].retriable, null);

  // lastSeen is the scope's own newest sighting (ISO): supplier CODE_A last
  // rejected 3 days ago — the 100-day attempt outside the window never moves it.
  const lastSeen = new Date(supplier[0].lastSeen);
  assert.ok(
    Math.abs(lastSeen.getTime() - threeDaysAgo.getTime()) < 5_000,
    `supplier lastSeen ~3 days ago, got ${supplier[0].lastSeen}`,
  );
});

test("another firm's rejections never leak in", async () => {
  const report = await computeRejectionRisk({
    id: invB,
    firmId: firmB,
    supplierPartyId: clientB,
    buyerPartyId: buyerX,
  });
  assert.equal(report.totalRejections, 1, "only firm B's own rejection");
  const supplier = report.signals.filter((s) => s.scope === "supplier");
  assert.deepEqual(
    supplier.map((s) => [s.errorCode, s.count]),
    [[CODE_A, 1]],
  );
});

test("route: same load/scope gate as the invoice detail (SEC-03)", async () => {
  const asAdmin = await listen(appFor(firmAdmin, invoicesRouter));
  const asOwner = await listen(appFor(clientS1, invoicesRouter));
  const asSibling = await listen(appFor(clientS2, invoicesRouter));
  const asOtherFirm = await listen(appFor(adminB, invoicesRouter));

  const ok = await fetch(`${asAdmin}/invoices/${inv1}/rejection-risk`);
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as {
    windowDays: number;
    totalRejections: number;
    signals: Array<{ errorCode: string; scope: string }>;
  };
  assert.equal(body.windowDays, 90);
  assert.equal(body.totalRejections, 7);
  assert.equal(body.signals[0].errorCode, CODE_A);
  assert.equal(body.signals[0].scope, "supplier");

  // The supplier client_user reads its own invoice's risk...
  assert.equal(
    (await fetch(`${asOwner}/invoices/${inv1}/rejection-risk`)).status,
    200,
  );
  // ...a sibling client of the same firm does not (403, like GET /invoices/:id).
  assert.equal(
    (await fetch(`${asSibling}/invoices/${inv1}/rejection-risk`)).status,
    403,
  );
  // Cross-tenant principals are rejected too.
  assert.equal(
    (await fetch(`${asOtherFirm}/invoices/${inv1}/rejection-risk`)).status,
    403,
  );
  // Unknown invoice: 404.
  assert.equal(
    (await fetch(`${asAdmin}/invoices/${randomUUID()}/rejection-risk`)).status,
    404,
  );
});
