import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  getDb,
  firmsTable,
  partiesTable,
  engagementsTable,
  usersTable,
  invoicesTable,
} from "@workspace/db";
import partiesRouter from "./parties.ts";
import type { Principal } from "../modules/auth/rbac.ts";
import { getFirmReceivables } from "../modules/invoice/receivables.ts";
import {
  appFor,
  listen,
  closeAllServers,
} from "../test-helpers/route-harness.ts";
import { makeRunSalt, daysAgo } from "../test-helpers/fixtures.ts";

// The "new customer" gap: party visibility is the firm's SPHERE (engaged ∪
// invoice-referenced ∪ captured-by-firm), with the strictly narrower SEC-03
// version for client_users (own party ∪ own-invoice parties ∪ own-captured).
// Plus the firm-level receivables rollup that rides the same fixtures.

const SALT = makeRunSalt();

const firmId = randomUUID();
const firmBId = randomUUID();
const userStaff = randomUUID();
const userClientA = randomUUID();
const clientA = randomUUID(); // engaged; clientUserA's own party
const clientB = randomUUID(); // engaged sibling client
const buyerX = randomUUID(); // on clientA's invoice — NOT engaged
const buyerY = randomUUID(); // on clientB's invoice only
const buyerOther = randomUUID(); // firm B's buyer — never visible to firm A

const staff: Principal = {
  userId: userStaff,
  role: "firm_staff",
  firmId,
  clientPartyId: null,
  buyerPartyId: null,
};
const clientUserA: Principal = {
  userId: userClientA,
  role: "client_user",
  firmId,
  clientPartyId: clientA,
  buyerPartyId: null,
};

after(async () => {
  await closeAllServers();
});

before(async () => {
  const db = getDb();
  await db
    .insert(usersTable)
    .values([
      { id: userStaff, email: `gap-staff-${SALT}@test.local` },
      { id: userClientA, email: `gap-client-${SALT}@test.local` },
    ])
    .onConflictDoNothing();
  await db.insert(firmsTable).values([
    { id: firmId, name: `Gap Firm A ${SALT}` },
    { id: firmBId, name: `Gap Firm B ${SALT}` },
  ]);
  await db.insert(partiesTable).values([
    { id: clientA, type: "client_business", legalName: `Gap Client A ${SALT}` },
    { id: clientB, type: "client_business", legalName: `Gap Client B ${SALT}` },
    { id: buyerX, type: "buyer", legalName: `Gap Buyer X ${SALT}` },
    { id: buyerY, type: "buyer", legalName: `Gap Buyer Y ${SALT}` },
    { id: buyerOther, type: "buyer", legalName: `Gap Buyer Other ${SALT}` },
  ]);
  await db.insert(engagementsTable).values([
    { firmId, clientPartyId: clientA, type: "readiness_assessment", title: "gap A" },
    { firmId, clientPartyId: clientB, type: "readiness_assessment", title: "gap B" },
  ]);
  await db.insert(invoicesTable).values([
    // clientA's book: one badly overdue, one current — both outstanding.
    {
      firmId,
      supplierPartyId: clientA,
      buyerPartyId: buyerX,
      invoiceNumber: `GAP-${SALT}-A1`,
      issueDate: daysAgo(150),
      dueDate: daysAgo(100),
      status: "stamped",
      grandTotal: "500.00",
      subtotal: "500.00",
    },
    {
      firmId,
      supplierPartyId: clientA,
      buyerPartyId: buyerX,
      invoiceNumber: `GAP-${SALT}-A2`,
      issueDate: daysAgo(20),
      dueDate: daysAgo(10),
      status: "submitted",
      grandTotal: "100.00",
      subtotal: "100.00",
    },
    // sibling clientB's invoice names buyerY.
    {
      firmId,
      supplierPartyId: clientB,
      buyerPartyId: buyerY,
      invoiceNumber: `GAP-${SALT}-B1`,
      issueDate: daysAgo(60),
      dueDate: daysAgo(45),
      status: "stamped",
      grandTotal: "200.00",
      subtotal: "200.00",
    },
    // an unrelated firm's invoice references buyerOther.
    {
      firmId: firmBId,
      supplierPartyId: clientB,
      buyerPartyId: buyerOther,
      invoiceNumber: `GAP-${SALT}-F1`,
      issueDate: daysAgo(10),
      dueDate: null,
      status: "stamped",
      grandTotal: "900.00",
      subtotal: "900.00",
    },
  ]);
});

test("firm staff see their sphere: engaged, invoice-referenced, and firm-captured parties", async () => {
  const base = await listen(appFor(staff, partiesRouter));

  // Capture a brand-new customer as the firm (no invoices reference it yet).
  const created = await fetch(`${base}/parties`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "buyer",
      legalName: `Gap Captured By Firm ${SALT}`,
    }),
  });
  assert.equal(created.status, 201);
  const capturedByFirm = (await created.json()) as { id: string };

  const rows = (await (await fetch(`${base}/parties?q=Gap`)).json()) as {
    id: string;
  }[];
  const ids = new Set(rows.map((p) => p.id));
  assert.ok(ids.has(clientA), "engaged client visible");
  assert.ok(ids.has(clientB), "engaged sibling visible to firm staff");
  assert.ok(ids.has(buyerX), "invoice-referenced buyer visible (the gap, closed)");
  assert.ok(ids.has(buyerY), "sibling's invoice-referenced buyer visible to firm staff");
  assert.ok(ids.has(capturedByFirm.id), "just-captured buyer visible before any invoice");
  assert.ok(!ids.has(buyerOther), "another firm's buyer never leaks");
});

test("a client_user sees only its own sphere (SEC-03)", async () => {
  const base = await listen(appFor(clientUserA, partiesRouter));

  // The client captures a customer of their own.
  const created = await fetch(`${base}/parties`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "buyer",
      legalName: `Gap Captured By Client ${SALT}`,
    }),
  });
  assert.equal(created.status, 201, "client_user can now capture a customer");
  const capturedByClient = (await created.json()) as { id: string };

  const rows = (await (await fetch(`${base}/parties?q=Gap`)).json()) as {
    id: string;
  }[];
  const ids = new Set(rows.map((p) => p.id));
  assert.ok(ids.has(clientA), "own party visible");
  assert.ok(ids.has(buyerX), "buyers on OWN invoices visible");
  assert.ok(ids.has(capturedByClient.id), "own captured customer visible immediately");
  assert.ok(!ids.has(clientB), "sibling client party hidden");
  assert.ok(!ids.has(buyerY), "sibling client's customer list hidden");
  assert.ok(!ids.has(buyerOther), "other firm's buyer hidden");
});

test("firm receivables rollup ranks clients and debtors, worst first", async () => {
  const rollup = await getFirmReceivables(firmId);

  const a = rollup.clients.find((c) => c.clientPartyId === clientA);
  const b = rollup.clients.find((c) => c.clientPartyId === clientB);
  assert.ok(a && b, "both clients with outstanding invoices appear");
  assert.equal(a!.outstandingTotal, "600.00");
  assert.equal(a!.invoiceCount, 2);
  assert.equal(a!.overdue90Amount, "500.00", "the 100-day invoice is 90+ overdue");
  assert.equal(a!.oldestDueDate, daysAgo(100));
  assert.equal(b!.outstandingTotal, "200.00");
  assert.ok(
    rollup.clients.indexOf(a!) < rollup.clients.indexOf(b!),
    "clients rank by outstanding, worst first",
  );

  const x = rollup.topDebtors.find((d) => d.buyerPartyId === buyerX);
  assert.ok(x, "buyerX is a top debtor");
  assert.equal(x!.outstanding, "600.00");
  assert.equal(x!.invoiceCount, 2);

  // Another firm's book never enters the rollup.
  assert.ok(
    rollup.topDebtors.every((d) => d.buyerPartyId !== buyerOther),
    "cross-tenant rows excluded",
  );
});
