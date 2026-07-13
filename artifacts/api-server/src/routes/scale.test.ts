import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import {
  getDb,
  firmsTable,
  partiesTable,
  engagementsTable,
  invoicesTable,
  clerkCasesTable,
  usersTable,
} from "@workspace/db";
import { API_CONTRACT_VERSION } from "@workspace/api-zod";
import invoicesRouter from "./invoices.ts";
import partiesRouter from "./parties.ts";
import healthRouter from "./health.ts";
import type { Principal } from "../modules/auth/rbac.ts";
import { listCases } from "../modules/clerk/cases.ts";
import { getReceivablesSummary } from "../modules/invoice/receivables.ts";
import {
  appFor,
  listen,
  closeAllServers,
} from "../test-helpers/route-harness.ts";
import { makeRunSalt, daysAgo } from "../test-helpers/fixtures.ts";

// Scale package: list pagination + search (invoices, parties, clerk cases),
// the receivables aging summary, and the build-version handshake. Uses the
// shared route-test harness (test-helpers/route-harness.ts); fixtures are
// salted per run because invoice rows are immutable once past draft and stay
// in the shared database forever.

const SALT = makeRunSalt();

after(async () => {
  await closeAllServers();
});

const firmId = randomUUID();
const userId = randomUUID();
const supplierA = randomUUID(); // engaged client of the firm
const supplierB = randomUUID(); // sibling client of the same firm
const buyerZebra = randomUUID();
const buyerYak = randomUUID();

const staff: Principal = {
  userId,
  role: "firm_staff",
  firmId,
  clientPartyId: null,
  buyerPartyId: null,
};
const clientUserA: Principal = {
  userId,
  role: "client_user",
  firmId,
  clientPartyId: supplierA,
  buyerPartyId: null,
};

// Six invoices for supplier A with staggered created_at (deterministic paging
// order) plus one for sibling supplier B (SEC-03 must hide it from A's user).
// Receivables spread: current / 31-60 / 90+ buckets, one settled (excluded),
// one draft (excluded), one credit note (excluded).
const INVOICES = [
  { num: `INV-${SALT}-1`, status: "submitted", due: daysAgo(10), buyer: buyerZebra, total: "100.00", kind: "invoice" },
  { num: `INV-${SALT}-2`, status: "stamped", due: daysAgo(45), buyer: buyerZebra, total: "200.00", kind: "invoice" },
  { num: `INV-${SALT}-3`, status: "confirmed", due: daysAgo(100), buyer: buyerYak, total: "700.00", kind: "invoice" },
  { num: `INV-${SALT}-4`, status: "settled", due: daysAgo(10), buyer: buyerYak, total: "400.00", kind: "invoice" },
  { num: `INV-${SALT}-5`, status: "draft", due: daysAgo(10), buyer: buyerZebra, total: "500.00", kind: "invoice" },
  { num: `INV-${SALT}-6`, status: "stamped", due: daysAgo(10), buyer: buyerZebra, total: "50.00", kind: "credit_note" },
] as const;

before(async () => {
  const db = getDb();
  await db.insert(usersTable).values({ id: userId, email: `scale-${SALT}@test.local` }).onConflictDoNothing();
  await db.insert(firmsTable).values({ id: firmId, name: `Scale Test Firm ${SALT}` });
  await db.insert(partiesTable).values([
    { id: supplierA, type: "client_business", legalName: `Scale Supplier Alpha ${SALT}` },
    { id: supplierB, type: "client_business", legalName: `Scale Supplier Beta ${SALT}` },
    { id: buyerZebra, type: "buyer", legalName: `Zebra${SALT} Logistics` },
    { id: buyerYak, type: "buyer", legalName: `Yak${SALT} Traders` },
  ]);
  await db.insert(engagementsTable).values([
    { firmId, clientPartyId: supplierA, type: "readiness_assessment", title: "scale A" },
    { firmId, clientPartyId: supplierB, type: "readiness_assessment", title: "scale B" },
  ]);
  const base = Date.now() - 60_000;
  await db.insert(invoicesTable).values(
    INVOICES.map((inv, i) => ({
      firmId,
      supplierPartyId: supplierA,
      buyerPartyId: inv.buyer,
      kind: inv.kind,
      invoiceNumber: inv.num,
      issueDate: daysAgo(120),
      dueDate: inv.due,
      status: inv.status,
      grandTotal: inv.total,
      subtotal: inv.total,
      createdAt: new Date(base + i * 1000),
    })),
  );
  // Sibling client's invoice: same firm, other supplier.
  await db.insert(invoicesTable).values({
    firmId,
    supplierPartyId: supplierB,
    buyerPartyId: buyerZebra,
    invoiceNumber: `INV-${SALT}-B1`,
    issueDate: daysAgo(120),
    dueDate: daysAgo(10),
    status: "submitted",
    grandTotal: "900.00",
    subtotal: "900.00",
    createdAt: new Date(base + 10_000),
  });
});

// ---------------------------------------------------------------------------
// Invoice pagination + search
// ---------------------------------------------------------------------------

test("paged invoice requests are bounded and newest-first; bare requests keep legacy order", async () => {
  const base = await listen(appFor(staff, invoicesRouter as express.Router));

  const paged = (await (await fetch(`${base}/invoices?limit=3&q=${SALT}`)).json()) as {
    invoiceNumber: string;
    createdAt: string;
  }[];
  assert.equal(paged.length, 3, "limit bounds the page");
  for (let i = 1; i < paged.length; i++) {
    assert.ok(
      new Date(paged[i - 1].createdAt) >= new Date(paged[i].createdAt),
      "paged results are newest first",
    );
  }

  const page2 = (await (
    await fetch(`${base}/invoices?limit=3&offset=3&q=${SALT}`)
  ).json()) as { invoiceNumber: string }[];
  assert.ok(page2.length >= 3, "second page continues the list");
  const page1Nums = new Set(paged.map((r) => r.invoiceNumber));
  for (const r of page2) {
    assert.ok(!page1Nums.has(r.invoiceNumber), "pages do not overlap");
  }

  // Bare request: full legacy list, oldest first, still contains everything.
  const all = (await (await fetch(`${base}/invoices`)).json()) as {
    invoiceNumber: string;
  }[];
  const mine = all.filter((r) => r.invoiceNumber.includes(SALT));
  assert.equal(mine.length, 7, "bare request returns the whole tenant list");
});

test("q matches invoice number and buyer legal name; wildcards are literal", async () => {
  const base = await listen(appFor(staff, invoicesRouter as express.Router));

  const byNumber = (await (
    await fetch(`${base}/invoices?q=INV-${SALT}-3`)
  ).json()) as { invoiceNumber: string }[];
  assert.deepEqual(
    byNumber.map((r) => r.invoiceNumber),
    [`INV-${SALT}-3`],
  );

  const byBuyer = (await (
    await fetch(`${base}/invoices?q=Zebra${SALT}`)
  ).json()) as { invoiceNumber: string }[];
  assert.ok(byBuyer.length >= 3, "buyer-name search finds that buyer's invoices");
  assert.ok(byBuyer.every((r) => r.invoiceNumber.includes(SALT)));

  const literal = (await (
    await fetch(`${base}/invoices?q=${encodeURIComponent(`%${SALT}`)}`)
  ).json()) as unknown[];
  assert.equal(literal.length, 0, "a % in the query is a literal, not a wildcard");
});

test("a client_user's search stays confined to its own invoices (SEC-03)", async () => {
  const base = await listen(appFor(clientUserA, invoicesRouter as express.Router));
  const rows = (await (await fetch(`${base}/invoices?q=${SALT}`)).json()) as {
    invoiceNumber: string;
  }[];
  assert.ok(rows.length >= 6);
  assert.ok(
    rows.every((r) => r.invoiceNumber !== `INV-${SALT}-B1`),
    "the sibling client's invoice must never appear",
  );
});

// ---------------------------------------------------------------------------
// Parties search
// ---------------------------------------------------------------------------

test("party search filters by name within the caller's scope", async () => {
  const base = await listen(appFor(staff, partiesRouter as express.Router));
  const hits = (await (
    await fetch(`${base}/parties?q=Supplier Alpha ${SALT}`)
  ).json()) as { id: string }[];
  assert.deepEqual(hits.map((p) => p.id), [supplierA]);

  // A client_user searching a sibling client's name gets nothing (SEC-03).
  const clientBase = await listen(
    appFor(clientUserA, partiesRouter as express.Router),
  );
  const sibling = (await (
    await fetch(`${clientBase}/parties?q=Supplier Beta ${SALT}`)
  ).json()) as unknown[];
  assert.equal(sibling.length, 0);
});

// ---------------------------------------------------------------------------
// Receivables aging
// ---------------------------------------------------------------------------

test("receivables aging buckets outstanding invoices and ranks debtors", async () => {
  const summary = await getReceivablesSummary(supplierA, firmId);
  assert.equal(summary.groups.length, 1, "one currency group (NGN)");
  const g = summary.groups[0];
  assert.equal(g.currency, "NGN");
  // Outstanding = submitted 100 (current) + stamped 200 (31-60) +
  // confirmed 700 (90+). Settled, draft and the credit note are excluded.
  assert.equal(g.invoiceCount, 3);
  assert.equal(g.outstandingTotal, "1000.00");
  assert.equal(g.buckets.current.amount, "100.00");
  assert.equal(g.buckets.current.count, 1);
  assert.equal(g.buckets.days31to60.amount, "200.00");
  assert.equal(g.buckets.days61to90.count, 0);
  assert.equal(g.buckets.days90plus.amount, "700.00");

  // Yak owes 700, Zebra 300 — biggest debtor first.
  assert.equal(summary.topDebtors[0]?.buyerPartyId, buyerYak);
  assert.equal(summary.topDebtors[0]?.outstanding, "700.00");
  assert.equal(summary.topDebtors[1]?.buyerPartyId, buyerZebra);
  assert.equal(summary.topDebtors[1]?.outstanding, "300.00");
  assert.equal(summary.topDebtors[0]?.oldestDueDate, daysAgo(100));
});

// ---------------------------------------------------------------------------
// Clerk case pagination
// ---------------------------------------------------------------------------

test("listCases pages are a window onto the unpaged list", async () => {
  const db = getDb();
  const base = Date.now() - 30_000;
  await db.insert(clerkCasesTable).values(
    [0, 1, 2].map((i) => ({
      kind: "question" as const,
      status: "pending" as const,
      question: `scale page probe ${SALT} ${i}`,
      createdBy: userId,
      createdAt: new Date(base + i * 1000),
    })),
  );
  const full = await listCases({ kind: "question", status: "pending" });
  const paged = await listCases({
    kind: "question",
    status: "pending",
    limit: 2,
    offset: 1,
  });
  assert.deepEqual(
    paged.map((c) => c.id),
    full.slice(1, 3).map((c) => c.id),
    "limit/offset slice the same ordering the full list uses",
  );
});

// ---------------------------------------------------------------------------
// Build-version handshake
// ---------------------------------------------------------------------------

test("healthz reports the baked-in contract version", async () => {
  const base = await listen(appFor(staff, healthRouter as express.Router));
  const body = (await (await fetch(`${base}/healthz`)).json()) as {
    status: string;
    contractVersion: string;
  };
  assert.equal(body.status, "ok");
  assert.equal(body.contractVersion, API_CONTRACT_VERSION);
  assert.match(body.contractVersion, /^\d+\.\d+\.\d+$/);
});
