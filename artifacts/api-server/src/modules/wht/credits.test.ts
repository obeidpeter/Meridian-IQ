import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  getDb,
  auditEventsTable,
  engagementsTable,
  firmsTable,
  invoicesTable,
  partiesTable,
  usersTable,
  whtCreditsTable,
} from "@workspace/db";
import { DomainError } from "../errors.ts";
import whtRouter from "../../routes/wht.ts";
import { WHT_RATES_BPS, whtRateBps } from "./rates.ts";
import {
  countWhtChase,
  listWhtCredits,
  loadWhtCreditForScope,
  markWhtNoteReceived,
  openWhtSamples,
  recordWhtCredit,
  whtCreditTotals,
} from "./credits.ts";
import type { Principal } from "../auth/rbac.ts";
import {
  appFor,
  listen,
  closeAllServers,
  JSON_HEADERS,
} from "../../test-helpers/route-harness.ts";
import { daysAgo, makeRunSalt } from "../../test-helpers/fixtures.ts";
import { clientPrincipal, firmPrincipal } from "../../test-helpers/principals.ts";

// The WHT credit ledger (WHT Desk). Pinned here:
//  - the closed rates catalogue and the SQL-computed default amount
//    (subtotal × bps / 10000 on the VAT-EXCLUSIVE base);
//  - recordWhtCredit: 404 for a foreign/missing invoice, WHT_NO_CATEGORY for
//    uncategorised paper, idempotent on the unique invoiceId key;
//  - markWhtNoteReceived: forward-only (409 on a second receipt), real-date
//    validation (WHT_BAD_DATE), pointer-only audit;
//  - listWhtCredits order + set-based totals, countWhtChase, openWhtSamples;
//  - the routes: SEC-03 narrowing on the list, the supplier-side scope wall
//    on record (404 non-disclosure), the loader on note, the required
//    clientPartyId + own-party assert on remittance.

const SALT = makeRunSalt();

const firmId = randomUUID();
const otherFirmId = randomUUID();
const clientA = randomUUID();
const clientB = randomUUID();
const buyerParty = randomUUID();
const userId = randomUUID();

const admin: Principal = firmPrincipal(firmId, { userId });
const clientUserB: Principal = clientPrincipal(firmId, clientB);

let invA1: string; // clientA's paper, services_5, subtotal 100000
let invA2: string; // clientA's paper, rent_10, subtotal 40000
let invNoCat: string; // clientA's paper, no category
let invB1: string; // clientB's paper, goods_2, subtotal 50000
let invForeign: string; // the other firm's paper

before(async () => {
  const db = getDb();
  await db
    .insert(usersTable)
    .values({ id: userId, email: `wht-credits-${SALT}@test.local` })
    .onConflictDoNothing();
  await db.insert(firmsTable).values([
    { id: firmId, name: `WHT Credits Firm ${SALT}` },
    { id: otherFirmId, name: `WHT Credits Firm B ${SALT}` },
  ]);
  await db.insert(partiesTable).values([
    { id: clientA, type: "client_business", legalName: `WHT Client A ${SALT}` },
    { id: clientB, type: "client_business", legalName: `WHT Client B ${SALT}` },
    { id: buyerParty, type: "buyer", legalName: `WHT Buyer ${SALT}` },
  ]);
  await db.insert(engagementsTable).values([
    { firmId, clientPartyId: clientA, type: "retainer", title: `wht cr A ${SALT}` },
    { firmId, clientPartyId: clientB, type: "retainer", title: `wht cr B ${SALT}` },
  ]);
  invA1 = randomUUID();
  invA2 = randomUUID();
  invNoCat = randomUUID();
  invB1 = randomUUID();
  invForeign = randomUUID();
  const invoice = (
    id: string,
    supplier: string,
    invoiceNumber: string,
    subtotal: string,
    whtCategory: string | null,
    firm = firmId,
  ) => ({
    id,
    firmId: firm,
    supplierPartyId: supplier,
    buyerPartyId: buyerParty,
    invoiceNumber,
    status: "stamped" as const,
    issueDate: daysAgo(20),
    subtotal,
    vatTotal: "0.00",
    grandTotal: subtotal,
    whtCategory,
  });
  await db.insert(invoicesTable).values([
    invoice(invA1, clientA, `WC-A1-${SALT}`, "100000.00", "services_5"),
    invoice(invA2, clientA, `WC-A2-${SALT}`, "40000.00", "rent_10"),
    invoice(invNoCat, clientA, `WC-NC-${SALT}`, "10000.00", null),
    invoice(invB1, clientB, `WC-B1-${SALT}`, "50000.00", "goods_2"),
    invoice(invForeign, clientA, `WC-F-${SALT}`, "9000.00", "services_5", otherFirmId),
  ]);
});

after(async () => {
  await closeAllServers();
});

test("the rates catalogue is closed and the lookup answers null off-catalogue", () => {
  assert.deepEqual(WHT_RATES_BPS, {
    goods_2: 200,
    works_2: 200,
    services_5: 500,
    commission_5: 500,
    rent_10: 1000,
    royalties_10: 1000,
  });
  assert.equal(whtRateBps("services_5"), 500);
  assert.equal(whtRateBps("rent_10"), 1000);
  assert.equal(whtRateBps(null), null);
  assert.equal(whtRateBps(undefined), null);
  assert.equal(whtRateBps("not_a_category"), null);
});

test("recordWhtCredit defaults to the SQL-computed expectation and is idempotent", async () => {
  const row = await recordWhtCredit(firmId, invA1, {
    deductedDate: daysAgo(5),
    source: "manual",
    recordedBy: userId,
  });
  assert.equal(row.invoiceId, invA1);
  assert.equal(row.invoiceNumber, `WC-A1-${SALT}`);
  assert.equal(row.clientPartyId, clientA, "SEC-03 key = the supplier client");
  assert.equal(row.category, "services_5");
  assert.equal(row.amount, "5000.00", "5% of the VAT-exclusive 100000.00");
  assert.equal(row.status, "awaiting_note");
  assert.equal(row.source, "manual");

  // Second record of the same deduction: the first row survives untouched —
  // even with a different amount supplied.
  const again = await recordWhtCredit(firmId, invA1, {
    amount: "9999.00",
    deductedDate: daysAgo(2),
    source: "manual",
  });
  assert.equal(again.id, row.id);
  assert.equal(again.amount, "5000.00");
  assert.equal(
    (
      await getDb()
        .select()
        .from(whtCreditsTable)
        .where(eq(whtCreditsTable.invoiceId, invA1))
    ).length,
    1,
    "one credit per invoice",
  );

  // Pointer-only audit for the record that WON (never the naira figure).
  const events = await getDb()
    .select()
    .from(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.entityType, "wht_credit"),
        eq(auditEventsTable.entityId, row.id),
      ),
    );
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "wht.credit.record");
  assert.deepEqual(
    Object.keys(events[0].after as Record<string, unknown>).sort(),
    ["category", "invoiceId", "source"],
    "pointer-only: the audit row carries no amount",
  );
});

test("recordWhtCredit refuses uncategorised paper, foreign invoices and bad inputs", async () => {
  await assert.rejects(
    recordWhtCredit(firmId, invNoCat, { deductedDate: daysAgo(1), source: "manual" }),
    (err: unknown) =>
      err instanceof DomainError &&
      err.code === "WHT_NO_CATEGORY" &&
      err.status === 400,
  );
  const notFound = (err: unknown) =>
    err instanceof DomainError && err.code === "NOT_FOUND" && err.status === 404;
  await assert.rejects(
    recordWhtCredit(firmId, randomUUID(), { deductedDate: daysAgo(1), source: "manual" }),
    notFound,
  );
  // A foreign firm's invoice id reads as missing (the firm-scoped load).
  await assert.rejects(
    recordWhtCredit(firmId, invForeign, { deductedDate: daysAgo(1), source: "manual" }),
    notFound,
  );
  const badDate = (err: unknown) =>
    err instanceof DomainError && err.code === "WHT_BAD_DATE" && err.status === 400;
  for (const bad of ["05/08/2026", "2026-8-2", "2026-02-30"]) {
    await assert.rejects(
      recordWhtCredit(firmId, invA2, { deductedDate: bad, source: "manual" }),
      badDate,
      `deductedDate ${bad} must be rejected`,
    );
  }
  await assert.rejects(
    recordWhtCredit(firmId, invA2, {
      amount: "not-money",
      deductedDate: daysAgo(1),
      source: "manual",
    }),
    (err: unknown) =>
      err instanceof DomainError && err.code === "WHT_BAD_AMOUNT" && err.status === 400,
  );
});

test("markWhtNoteReceived walks forward once, validates the date, audits pointer-only", async () => {
  const credit = await recordWhtCredit(firmId, invA2, {
    amount: "3500.00", // the buyer's real figure beats the 4000.00 expectation
    deductedDate: daysAgo(10),
    source: "manual",
    recordedBy: userId,
  });
  assert.equal(credit.amount, "3500.00");

  const badDate = (err: unknown) =>
    err instanceof DomainError && err.code === "WHT_BAD_DATE" && err.status === 400;
  await assert.rejects(
    markWhtNoteReceived(firmId, credit.id, {
      noteReference: `TPM-${SALT}`,
      noteDate: "2026-02-30",
    }),
    badDate,
  );

  const updated = await markWhtNoteReceived(
    firmId,
    credit.id,
    { noteReference: `TPM-${SALT}`, noteDate: daysAgo(1) },
    userId,
  );
  assert.equal(updated?.status, "note_received");
  assert.equal(updated?.noteReference, `TPM-${SALT}`);
  assert.equal(updated?.noteDate, daysAgo(1));

  // Forward-only: a second receipt is a conflict.
  await assert.rejects(
    markWhtNoteReceived(firmId, credit.id, {
      noteReference: "AGAIN",
      noteDate: daysAgo(0),
    }),
    (err: unknown) =>
      err instanceof DomainError &&
      err.code === "WHT_BAD_TRANSITION" &&
      err.status === 409,
  );

  // A foreign firm's id updates zero rows — the route's 404 path.
  assert.equal(
    await markWhtNoteReceived(otherFirmId, credit.id, {
      noteReference: "X",
      noteDate: daysAgo(0),
    }),
    null,
  );

  // Pointer-only audit: the walk, never the note reference.
  const events = await getDb()
    .select()
    .from(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.entityType, "wht_credit"),
        eq(auditEventsTable.entityId, credit.id),
      ),
    );
  const note = events.find((e) => e.action === "wht.credit.note");
  assert.ok(note);
  assert.deepEqual(note.before, { status: "awaiting_note" });
  assert.deepEqual(note.after, { status: "note_received" });
});

test("listWhtCredits orders by deduction recency with set-based totals; the fact helpers agree", async () => {
  // Ledger so far: invA1 awaiting (5000.00, deducted -5d), invA2 received
  // (3500.00, deducted -10d). Add clientB's credit for the scope splits.
  await recordWhtCredit(firmId, invB1, {
    deductedDate: daysAgo(3),
    source: "manual",
  });

  const all = await listWhtCredits(firmId);
  assert.deepEqual(
    all.credits.map((c) => c.invoiceId),
    [invB1, invA1, invA2],
    "most recent deductedDate first",
  );
  assert.deepEqual(all.totals, {
    awaitingNote: 2,
    noteReceived: 1,
    awaitingAmount: "6000.00", // 5000 (A1) + 1000 (B1: 2% of 50000)
    totalAmount: "9500.00",
  });

  // The status filter narrows the LIST but never the totals.
  const awaiting = await listWhtCredits(firmId, { status: "awaiting_note" });
  assert.equal(awaiting.credits.length, 2);
  assert.deepEqual(awaiting.totals, all.totals);

  // The client filter narrows both.
  const forA = await listWhtCredits(firmId, { clientPartyId: clientA });
  assert.deepEqual(
    forA.credits.map((c) => c.invoiceId),
    [invA1, invA2],
  );
  assert.deepEqual(forA.totals, {
    awaitingNote: 1,
    noteReceived: 1,
    awaitingAmount: "5000.00",
    totalAmount: "8500.00",
  });

  // Paging.
  const page = await listWhtCredits(firmId, { limit: 1, offset: 1 });
  assert.deepEqual(
    page.credits.map((c) => c.invoiceId),
    [invA1],
  );

  // A foreign firm reads empty zeros.
  const foreign = await listWhtCredits(otherFirmId);
  assert.deepEqual(foreign.credits, []);
  assert.deepEqual(foreign.totals, {
    awaitingNote: 0,
    noteReceived: 0,
    awaitingAmount: "0.00",
    totalAmount: "0.00",
  });

  // The single-fact helpers compose the same pass.
  assert.deepEqual(await countWhtChase(firmId), {
    awaiting: 2,
    awaitingAmount: "6000.00",
  });
  assert.deepEqual(await countWhtChase(firmId, clientA), {
    awaiting: 1,
    awaitingAmount: "5000.00",
  });
  assert.deepEqual(await whtCreditTotals(firmId, clientB), {
    awaitingNote: 1,
    noteReceived: 0,
    awaitingAmount: "1000.00",
    totalAmount: "1000.00",
  });

  // The pack sample: awaiting only, oldest deduction first.
  const samples = await openWhtSamples(firmId, clientA);
  assert.deepEqual(samples, [
    {
      invoiceNumber: `WC-A1-${SALT}`,
      category: "services_5",
      amount: "5000.00",
      deductedDate: daysAgo(5),
    },
  ]);
});

test("SEC-03: the loader's 404 non-disclosure", async () => {
  const { credits } = await listWhtCredits(firmId, { clientPartyId: clientA });
  const creditA = credits[0];
  assert.equal(
    (await loadWhtCreditForScope(creditA.id, admin)).id,
    creditA.id,
  );
  const notFound = (err: unknown) =>
    err instanceof DomainError && err.code === "NOT_FOUND" && err.status === 404;
  // Missing id, foreign tenant and sibling client are indistinguishable.
  await assert.rejects(loadWhtCreditForScope(randomUUID(), admin), notFound);
  await assert.rejects(
    loadWhtCreditForScope(creditA.id, firmPrincipal(otherFirmId)),
    notFound,
  );
  await assert.rejects(loadWhtCreditForScope(creditA.id, clientUserB), notFound);
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

test("GET /wht/credits pins a client_user to its own party (SEC-03)", async () => {
  const base = await listen(appFor(clientUserB, whtRouter));
  // No filter: pinned to clientB's own ledger.
  const res = await fetch(`${base}/wht/credits`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    credits: { clientPartyId: string }[];
    totals: { awaitingNote: number };
  };
  assert.ok(body.credits.length > 0);
  assert.ok(body.credits.every((c) => c.clientPartyId === clientB));
  assert.equal(body.totals.awaitingNote, 1);
  // A sibling filter is rejected outright (CROSS_CLIENT — the filings list
  // posture), never silently honoured.
  const sibling = await fetch(`${base}/wht/credits?clientPartyId=${clientA}`);
  assert.equal(sibling.status, 403);

  // Firm staff read firm-wide.
  const staffBase = await listen(appFor(admin, whtRouter));
  const staffRes = await fetch(`${staffBase}/wht/credits`);
  const staffBody = (await staffRes.json()) as { credits: unknown[] };
  assert.equal(staffBody.credits.length, 3);
});

test("POST /wht/credits walls sibling paper behind 404 and answers 201 idempotently", async () => {
  // A fresh categorised invoice for clientA to record through the route.
  const invRoute = randomUUID();
  await getDb().insert(invoicesTable).values({
    id: invRoute,
    firmId,
    supplierPartyId: clientA,
    buyerPartyId: buyerParty,
    invoiceNumber: `WC-RT-${SALT}`,
    status: "stamped",
    issueDate: daysAgo(8),
    subtotal: "20000.00",
    vatTotal: "1500.00",
    grandTotal: "21500.00",
    whtCategory: "commission_5",
  });

  // A client_user of a SIBLING party: 404, not 403 — non-disclosure.
  const siblingBase = await listen(appFor(clientUserB, whtRouter));
  const walled = await fetch(`${siblingBase}/wht/credits`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ invoiceId: invRoute, deductedDate: daysAgo(1) }),
  });
  assert.equal(walled.status, 404);

  const base = await listen(appFor(admin, whtRouter));
  const created = await fetch(`${base}/wht/credits`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ invoiceId: invRoute, deductedDate: daysAgo(1) }),
  });
  assert.equal(created.status, 201);
  const row = (await created.json()) as { id: string; amount: string; source: string };
  assert.equal(row.amount, "1000.00", "5% of 20000.00");
  assert.equal(row.source, "manual");

  // Recording again: still 201, the SAME surviving row.
  const again = await fetch(`${base}/wht/credits`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ invoiceId: invRoute, deductedDate: daysAgo(0) }),
  });
  assert.equal(again.status, 201);
  assert.equal(((await again.json()) as { id: string }).id, row.id);

  // The note route: loader 404s a sibling's credit; the owner walks it.
  const noteWalled = await fetch(`${siblingBase}/wht/credits/${row.id}/note`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ noteReference: `RT-${SALT}`, noteDate: daysAgo(0) }),
  });
  assert.equal(noteWalled.status, 404);
  const noted = await fetch(`${base}/wht/credits/${row.id}/note`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ noteReference: `RT-${SALT}`, noteDate: daysAgo(0) }),
  });
  assert.equal(noted.status, 200);
  assert.equal(
    ((await noted.json()) as { status: string }).status,
    "note_received",
  );
  const conflicted = await fetch(`${base}/wht/credits/${row.id}/note`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ noteReference: "AGAIN", noteDate: daysAgo(0) }),
  });
  assert.equal(conflicted.status, 409);
});
