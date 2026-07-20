import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  getDb,
  firmsTable,
  partiesTable,
  invoicesTable,
  submissionAttemptsTable,
  billingTiersTable,
  firmSubscriptionsTable,
  clerkInferenceCallsTable,
} from "@workspace/db";
import {
  computeBillingStatement,
  computeBillingFee,
} from "./billing-statement.ts";
import { closedLagosMonths } from "../clerk/vat-pack.ts";
import { lagosMonthStart, monthLabel } from "../clerk/client-statement.ts";
import invoicesRouter from "../../routes/invoices.ts";
import type { Principal } from "../auth/rbac.ts";
import {
  appFor,
  listen,
  closeAllServers,
} from "../../test-helpers/route-harness.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Monthly platform-billing statement. Pinned invariants:
//  - accepted invoices use the vat-pack predicate exactly: Lagos issue-month
//    basis, kind=invoice, cancelled excluded, an accepted attempt WHENEVER it
//    happened; credit notes and other firms never count;
//  - submission attempts are the Lagos month's traffic; Clerk metering is the
//    UTC month (budget.ts's boundary) — the same instant can be inside one
//    window and outside the other, and the statement keeps them apart;
//  - fee = base + max(0, accepted − included) × overage price, 2dp strings;
//  - no subscription falls back to the essential tier; a null tier allowance
//    surfaces as null (env default), never resolved here;
//  - routes: console.portfolio.read + firm scope, closed-month discipline
//    (400 outside the option list), CSV attachment with the disclosure row.

const SALT = makeRunSalt();

const firmA = randomUUID();
const firmB = randomUUID();
const firmC = randomUUID(); // no subscription → essential fallback
const supplierA = randomUUID();
const supplierB = randomUUID();
const buyerX = randomUUID();

// The newest closed Lagos month (what the statement defaults to).
const MONTH = lagosMonthStart(1);
const monthDay = (day: number) => `${MONTH.slice(0, 8)}${String(day).padStart(2, "0")}`;
// Inside the month in BOTH calendars (noon UTC on the 10th).
const inMonthUtc = new Date(`${monthDay(10)}T12:00:00.000Z`);
// The month-edge instant: 23:30 UTC the day BEFORE the month starts is
// already 00:30 on the 1st in Lagos — inside the Lagos month, outside the
// UTC month. The Lagos-bucketed attempts count must include it; the
// UTC-bucketed Clerk meter must not.
const monthStartUtc = new Date(`${MONTH}T00:00:00.000Z`);
const edgeInstant = new Date(monthStartUtc.getTime() - 30 * 60 * 1000);

const TIER = {
  essential: {
    name: `Essential ${SALT}`,
    monthlyPrice: "10000",
    includedInvoices: 100,
    overagePrice: "150",
    revenueSharePct: "0.2",
    clerkMonthlyTokens: null as number | null,
  },
  professional: {
    name: `Professional ${SALT}`,
    monthlyPrice: "40000",
    includedInvoices: 2,
    overagePrice: "125",
    revenueSharePct: "0.25",
    clerkMonthlyTokens: 5_000_000 as number | null,
  },
};

const firmAdminA: Principal = {
  userId: randomUUID(),
  role: "firm_admin",
  firmId: firmA,
  clientPartyId: null,
  buyerPartyId: null,
};
const clientA: Principal = {
  ...firmAdminA,
  userId: randomUUID(),
  role: "client_user",
  clientPartyId: supplierA,
};

before(async () => {
  const db = getDb();
  await db.insert(firmsTable).values([
    { id: firmA, name: `Bill Firm A ${SALT}` },
    { id: firmB, name: `Bill Firm B ${SALT}` },
    { id: firmC, name: `Bill Firm C ${SALT}` },
  ]);
  await db.insert(partiesTable).values([
    { id: supplierA, type: "client_business", legalName: `Bill Supplier A ${SALT}` },
    { id: supplierB, type: "client_business", legalName: `Bill Supplier B ${SALT}` },
    { id: buyerX, type: "buyer", legalName: `Bill Buyer ${SALT}` },
  ]);

  // Tier config is global reference data keyed by the enum; pin the values
  // this file asserts on (upsert — the scratch DB may already carry rows).
  for (const [key, cfg] of Object.entries(TIER)) {
    await db
      .insert(billingTiersTable)
      .values({ key: key as never, ...cfg })
      .onConflictDoUpdate({ target: billingTiersTable.key, set: { ...cfg } });
  }
  const [pro] = await db
    .select()
    .from(billingTiersTable)
    .where(eq(billingTiersTable.key, "professional"));
  await db.insert(firmSubscriptionsTable).values({
    firmId: firmA,
    tierId: pro.id,
  });

  const mkInvoice = async (
    firmId: string,
    supplier: string,
    n: string,
    opts: { kind?: string; status?: string; issueDate?: string } = {},
  ) => {
    const id = randomUUID();
    await db.insert(invoicesTable).values({
      id,
      firmId,
      supplierPartyId: supplier,
      buyerPartyId: buyerX,
      invoiceNumber: n,
      kind: (opts.kind ?? "invoice") as never,
      issueDate: opts.issueDate ?? monthDay(5),
      status: (opts.status ?? "stamped") as never,
    });
    return id;
  };
  const attempt = async (
    invoiceId: string,
    no: number,
    status: string,
    createdAt: Date,
  ) => {
    await db.insert(submissionAttemptsTable).values({
      invoiceId,
      rail: "rail_primary",
      attemptNo: no,
      idempotencyKey: `bill-${invoiceId}-${no}`,
      status: status as never,
      createdAt,
    });
  };

  // Firm A, in-month accepted invoices: 3.
  const inv1 = await mkInvoice(firmA, supplierA, `BILL-1-${SALT}`);
  const inv2 = await mkInvoice(firmA, supplierA, `BILL-2-${SALT}`);
  const inv3 = await mkInvoice(firmA, supplierA, `BILL-3-${SALT}`);
  // In-month but never accepted: counts in attempt traffic only.
  const inv4 = await mkInvoice(firmA, supplierA, `BILL-4-${SALT}`, {
    status: "failed",
  });
  // Cancelled: excluded from the accepted count whatever the rails said.
  const inv5 = await mkInvoice(firmA, supplierA, `BILL-5-${SALT}`, {
    status: "cancelled",
  });
  // Credit note: never an accepted INVOICE.
  const cn1 = await mkInvoice(firmA, supplierA, `BILL-CN-${SALT}`, {
    kind: "credit_note",
  });
  // Issued the month before: issue-month basis excludes it.
  const prevMonth = lagosMonthStart(2);
  const invPrev = await mkInvoice(firmA, supplierA, `BILL-P-${SALT}`, {
    issueDate: `${prevMonth.slice(0, 8)}15`,
  });
  // Another firm's accepted invoice: invisible.
  const invB = await mkInvoice(firmB, supplierB, `BILL-B-${SALT}`);

  await attempt(inv1, 1, "accepted", inMonthUtc);
  // Accepted AFTER the month closed — the invoice still counts (issue-month
  // basis, acceptance whenever it happened), the attempt traffic does not.
  await attempt(inv2, 1, "accepted", new Date(monthStartUtc.getTime() + 33 * 86_400_000));
  await attempt(inv3, 1, "accepted", inMonthUtc);
  await attempt(inv4, 1, "rejected", inMonthUtc);
  await attempt(inv5, 1, "accepted", inMonthUtc);
  await attempt(cn1, 1, "accepted", inMonthUtc);
  await attempt(invPrev, 1, "accepted", new Date(monthStartUtc.getTime() - 10 * 86_400_000));
  await attempt(invB, 1, "accepted", inMonthUtc);
  // Lagos-in / UTC-out edge attempt: counts toward the Lagos attempt traffic.
  await attempt(inv1, 2, "rejected", edgeInstant);
  // Expected: attempts = inv1#1 + inv3 + inv4 + inv5 + cn1 + inv1#2 = 6.

  // Clerk ledger: UTC-month metering.
  const call = (
    firmId: string | null,
    purpose: string,
    promptTokens: number,
    completionTokens: number,
    createdAt: Date,
  ) => ({
    firmId,
    purpose,
    model: "test-model",
    promptVersion: "test.v1",
    inputRef: `bill-${SALT}-${randomUUID()}`,
    schemaValid: true,
    outcome: "ok" as never,
    promptTokens,
    completionTokens,
    createdAt,
  });
  await db.insert(clerkInferenceCallsTable).values([
    call(firmA, "extract_invoice", 1000, 200, inMonthUtc),
    call(firmA, "extract_invoice", 500, 0, inMonthUtc),
    call(firmA, "ask_clerk", 300, 100, inMonthUtc),
    // The Lagos-in / UTC-out instant: the UTC meter must exclude it.
    call(firmA, "extract_invoice", 999, 0, edgeInstant),
    // Platform traffic (no firm) and another firm's spend: excluded.
    call(null, "extract_invoice", 777, 0, inMonthUtc),
    call(firmB, "extract_invoice", 888, 0, inMonthUtc),
  ]);
});

after(async () => {
  await closeAllServers();
});

test("computeBillingFee: overage maths, 2dp strings", () => {
  const tier = { monthlyPrice: "40000", includedInvoices: 2, overagePrice: "125" };
  assert.deepEqual(computeBillingFee(tier, 0), {
    base: "40000.00",
    overageInvoices: 0,
    overage: "0.00",
    total: "40000.00",
  });
  assert.deepEqual(computeBillingFee(tier, 2), {
    base: "40000.00",
    overageInvoices: 0,
    overage: "0.00",
    total: "40000.00",
  });
  assert.deepEqual(computeBillingFee(tier, 5), {
    base: "40000.00",
    overageInvoices: 3,
    overage: "375.00",
    total: "40375.00",
  });
});

test("statement: counts, calendars kept apart, tier and fee", async () => {
  const s = await computeBillingStatement(firmA, MONTH);
  assert.equal(s.monthStart, MONTH);
  assert.equal(s.monthLabel, monthLabel(MONTH));
  // Closed-month option list with display labels.
  assert.deepEqual(
    s.months.map((m) => m.value),
    closedLagosMonths(),
  );
  assert.equal(s.months[0].label, monthLabel(MONTH));

  // Accepted: inv1..inv3 only — no cancelled, no credit note, no prev-month,
  // no unaccepted, no other firm.
  assert.equal(s.usage.acceptedInvoices, 3);
  // Attempts: the Lagos month's traffic, including the UTC-out edge attempt.
  assert.equal(s.usage.submissionAttempts, 6);
  // Clerk meter: UTC month — the edge call is OUT, platform/other-firm out.
  assert.equal(s.usage.clerkTokens, 2100);
  assert.equal(s.usage.clerkCalls, 3);
  assert.deepEqual(s.usage.byPurpose, [
    { purpose: "extract_invoice", tokens: 1700 },
    { purpose: "ask_clerk", tokens: 400 },
  ]);

  // Tier straight from the subscription join; allowance surfaces as set.
  assert.equal(s.tier.key, "professional");
  assert.equal(s.tier.name, TIER.professional.name);
  assert.equal(s.tier.monthlyPrice, "40000.00");
  assert.equal(s.tier.includedInvoices, 2);
  assert.equal(s.tier.overagePrice, "125.00");
  assert.equal(s.tier.clerkMonthlyTokens, 5_000_000);

  // Fee: 3 accepted on included 2 → 1 overage.
  assert.deepEqual(s.fee, {
    base: "40000.00",
    overageInvoices: 1,
    overage: "125.00",
    total: "40125.00",
  });
  // The disclosure names both calendars.
  assert.ok(s.note.includes("Lagos"), "note names the Lagos basis");
  assert.ok(s.note.includes("UTC"), "note names the UTC Clerk meter");
});

test("no subscription: essential fallback, null allowance surfaces as null", async () => {
  const s = await computeBillingStatement(firmC, MONTH);
  assert.equal(s.tier.key, "essential");
  assert.equal(s.tier.clerkMonthlyTokens, null);
  assert.equal(s.usage.acceptedInvoices, 0);
  assert.equal(s.usage.clerkTokens, 0);
  assert.deepEqual(s.usage.byPurpose, []);
  assert.deepEqual(s.fee, {
    base: "10000.00",
    overageInvoices: 0,
    overage: "0.00",
    total: "10000.00",
  });
});

test("routes: gates, closed-month discipline and CSV attachment", async () => {
  const asAdmin = await listen(appFor(firmAdminA, invoicesRouter));
  const asClient = await listen(appFor(clientA, invoicesRouter));

  // Defaults to the newest closed month.
  const ok = await fetch(`${asAdmin}/billing/statement`);
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as {
    monthStart: string;
    usage: { acceptedInvoices: number };
    fee: { total: string };
  };
  assert.equal(body.monthStart, MONTH);
  assert.equal(body.usage.acceptedInvoices, 3);
  assert.equal(body.fee.total, "40125.00");

  // An explicit closed month works; the OPEN month is refused (closed-month
  // discipline), as is garbage.
  assert.equal(
    (await fetch(`${asAdmin}/billing/statement?month=${MONTH}`)).status,
    200,
  );
  assert.equal(
    (await fetch(`${asAdmin}/billing/statement?month=${lagosMonthStart(0)}`))
      .status,
    400,
  );
  assert.equal(
    (await fetch(`${asAdmin}/billing/statement?month=never`)).status,
    400,
  );
  // A client_user has no console.portfolio.read: the firm's platform bill is
  // not client-visible.
  assert.equal((await fetch(`${asClient}/billing/statement`)).status, 403);

  // CSV export: same gates, attachment headers, figures and disclosure.
  const csv = await fetch(`${asAdmin}/billing/statement/export`);
  assert.equal(csv.status, 200);
  assert.equal(csv.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.equal(
    csv.headers.get("content-disposition"),
    `attachment; filename="billing-statement-${MONTH.slice(0, 7)}.csv"`,
  );
  const text = await csv.text();
  assert.ok(text.includes("item,value"), "header row");
  assert.ok(text.includes("acceptedInvoices,3"));
  assert.ok(text.includes("totalFee,40125.00"));
  assert.ok(text.includes("clerkTokens:extract_invoice,1700"));
  assert.ok(text.includes("UTC"), "disclosure travels with the file");
  assert.equal((await fetch(`${asClient}/billing/statement/export`)).status, 403);
});
