import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  getDb,
  billVerificationsTable,
  consentRecordsTable,
  engagementsTable,
  firmsTable,
  invoicesTable,
  partiesTable,
  settlementEventsTable,
  stampRecordsTable,
  usersTable,
} from "@workspace/db";
import billsRouter from "./bills.ts";
import invoicesRouter from "./invoices/index.ts";
import smeRouter from "./sme.ts";
import { createDraft } from "../modules/invoice/service.ts";
import type { Principal } from "../modules/auth/rbac.ts";
import {
  appFor,
  listen,
  closeAllServers,
  JSON_HEADERS,
} from "../test-helpers/route-harness.ts";
import { makeRunSalt } from "../test-helpers/fixtures.ts";
import { clientPrincipal, firmPrincipal } from "../test-helpers/principals.ts";

// Supplier payables (contract 0.44.0). Pinned here:
//  - the bills routes' own buyer-side scope wall: a sibling client's bill, a
//    receivable and a foreign tenant's invoice are all 404 non-disclosure;
//  - payment flags are settlement EVIDENCE only (source payer_flag): the
//    derived payStatus flips scheduled -> paid while the invoice row itself
//    never leaves 'draft';
//  - verify-stamp persists a bill_verifications row for both the known-stamp
//    (valid) and unknown-stamp (valid:false, eligible null) outcomes;
//  - the payables summary buckets unpaid bills by due date (overdue / due
//    weeks / later — no due date is later), with top suppliers;
//  - the SUBMIT GUARD: validate, submit and credit-note all 409
//    NOT_SUBMITTABLE on a bill, while a receivable still submits;
//  - the SME calendar carries bill_due deadlines for unpaid due bills.

const SALT = makeRunSalt();
const firmA = randomUUID();
const firmB = randomUUID();
const clientParty = randomUUID(); // engaged with firm A — the bills' BUYER
const siblingParty = randomUUID(); // engaged with firm A — the SEC-03 probe
const summaryClient = randomUUID(); // engaged — isolated summary fixtures
const vendorParty = randomUUID(); // NOT engaged — the bills' supplier
const buyerParty = randomUUID(); // ordinary receivable buyer
const adminId = randomUUID();

const admin: Principal = firmPrincipal(firmA, { userId: adminId });
const adminB: Principal = { ...admin, userId: randomUUID(), firmId: firmB };
const clientUser: Principal = clientPrincipal(firmA, clientParty);
const siblingUser: Principal = {
  ...clientUser,
  userId: randomUUID(),
  clientPartyId: siblingParty,
};

function dateOffset(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// A bill row: supplier = vendor (not engaged), buyer = an engaged client.
async function seedBill(input: {
  buyerPartyId: string;
  invoiceNumber: string;
  grandTotal: string;
  dueDate: string | null;
}): Promise<string> {
  const id = randomUUID();
  await getDb().insert(invoicesTable).values({
    id,
    firmId: firmA,
    supplierPartyId: vendorParty,
    buyerPartyId: input.buyerPartyId,
    invoiceNumber: input.invoiceNumber,
    status: "draft",
    issueDate: dateOffset(-4),
    dueDate: input.dueDate,
    grandTotal: input.grandTotal,
    subtotal: input.grandTotal,
    vatTotal: "0.00",
  });
  return id;
}

let billFlagId: string; // takes the scheduled->paid flag sequence
let billOpenId: string; // stays open: verify-stamp, guard and calendar probes
let recvDraftId: string; // receivable draft: still validates and submits
let recvStampedId: string; // stamped receivable backing the known-stamp check
const KNOWN_IRN = `IRN-BILLS-${SALT}`;
const KNOWN_CSID = `CSID-BILLS-${SALT}`;

before(async () => {
  const db = getDb();
  await db
    .insert(usersTable)
    .values({ id: adminId, email: `bills-${SALT}@test.local` })
    .onConflictDoNothing();
  await db.insert(firmsTable).values([
    { id: firmA, name: `Bills Firm A ${SALT}` },
    { id: firmB, name: `Bills Firm B ${SALT}` },
  ]);
  await db.insert(partiesTable).values([
    {
      id: clientParty,
      type: "client_business",
      legalName: `Bills Client ${SALT}`,
      tin: "10000000-0001",
      street: "1 Marina Rd",
      city: "Lagos",
    },
    {
      id: siblingParty,
      type: "client_business",
      legalName: `Bills Sibling ${SALT}`,
    },
    {
      id: summaryClient,
      type: "client_business",
      legalName: `Bills Summary Client ${SALT}`,
    },
    {
      id: vendorParty,
      type: "buyer",
      legalName: `Bills Vendor ${SALT}`,
    },
    {
      id: buyerParty,
      type: "buyer",
      legalName: `Bills Buyer ${SALT}`,
      tin: "20000000-0001",
      street: "3 Broad St",
      city: "Lagos",
    },
  ]);
  await db.insert(engagementsTable).values([
    { firmId: firmA, clientPartyId: clientParty, type: "retainer", title: `bills A ${SALT}` },
    { firmId: firmA, clientPartyId: siblingParty, type: "retainer", title: `bills B ${SALT}` },
    { firmId: firmA, clientPartyId: summaryClient, type: "retainer", title: `bills C ${SALT}` },
  ]);
  // Layer-1 consent so the RECEIVABLE control invoice can submit.
  await db.insert(consentRecordsTable).values({
    partyId: clientParty,
    layer: 1,
    action: "grant",
    scope: "compliance_submission",
    basis: "contract",
    channel: "test",
  });

  billFlagId = await seedBill({
    buyerPartyId: clientParty,
    invoiceNumber: `BILL-FLAG-${SALT}`,
    grandTotal: "150.00",
    dueDate: dateOffset(5),
  });
  billOpenId = await seedBill({
    buyerPartyId: clientParty,
    invoiceNumber: `BILL-OPEN-${SALT}`,
    grandTotal: "250.00",
    dueDate: dateOffset(5),
  });

  // Summary fixtures (their own client so the flag tests cannot disturb the
  // buckets): due in week 0, week 1, overdue, no due date, and a paid one.
  await seedBill({
    buyerPartyId: summaryClient,
    invoiceNumber: `BILL-W0-${SALT}`,
    grandTotal: "100.00",
    dueDate: dateOffset(2),
  });
  await seedBill({
    buyerPartyId: summaryClient,
    invoiceNumber: `BILL-W1-${SALT}`,
    grandTotal: "200.00",
    dueDate: dateOffset(9),
  });
  await seedBill({
    buyerPartyId: summaryClient,
    invoiceNumber: `BILL-LATE-${SALT}`,
    grandTotal: "400.00",
    dueDate: dateOffset(-3),
  });
  await seedBill({
    buyerPartyId: summaryClient,
    invoiceNumber: `BILL-NODUE-${SALT}`,
    grandTotal: "800.00",
    dueDate: null,
  });
  const paidId = await seedBill({
    buyerPartyId: summaryClient,
    invoiceNumber: `BILL-PAID-${SALT}`,
    grandTotal: "1600.00",
    dueDate: dateOffset(1),
  });
  await db.insert(settlementEventsTable).values({
    invoiceId: paidId,
    source: "payer_flag",
    amount: "1600.00",
    paymentStatus: "paid",
    actorId: adminId,
    occurredAt: new Date(),
  });

  // Receivable control paper: a draft that must still validate+submit, and a
  // stamped invoice whose stamp record backs the known-stamp verification.
  const draft = await createDraft(
    {
      firmId: firmA,
      supplierPartyId: clientParty,
      buyerPartyId: buyerParty,
      invoiceNumber: `RECV-${SALT}`,
      issueDate: dateOffset(-1),
      lines: [
        { description: "Goods", quantity: "1", unitPrice: "1000", vatRate: "0.075" },
      ],
    },
    adminId,
  );
  recvDraftId = draft.invoice.id;
  recvStampedId = randomUUID();
  await db.insert(invoicesTable).values({
    id: recvStampedId,
    firmId: firmA,
    supplierPartyId: clientParty,
    buyerPartyId: buyerParty,
    invoiceNumber: `RECV-ST-${SALT}`,
    status: "stamped",
    issueDate: dateOffset(-10),
    grandTotal: "500.00",
  });
  await db.insert(stampRecordsTable).values({
    invoiceId: recvStampedId,
    irn: KNOWN_IRN,
    csid: KNOWN_CSID,
    qrPayload: `https://verify.test/${KNOWN_IRN}`,
    signedArtifactRef: `artifact://test/${SALT}.xml`,
    rail: "rail_primary",
  });
});

after(async () => {
  await closeAllServers();
});

// ---------------------------------------------------------------------------
// Scope walls
// ---------------------------------------------------------------------------

test("bill routes 404 for a sibling client, a receivable and a foreign tenant", async () => {
  const sibling = await listen(appFor(siblingUser, billsRouter));
  const own = await listen(appFor(admin, billsRouter));
  const foreign = await listen(appFor(adminB, billsRouter));

  // Sibling client_user cannot reach clientParty's bill (SEC-03) — 404, not 403.
  for (const path of [
    `/bills/${billOpenId}/payment-flag`,
    `/bills/${billOpenId}/verify-stamp`,
  ]) {
    const res = await fetch(`${sibling}${path}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(
        path.endsWith("payment-flag")
          ? { status: "scheduled" }
          : { irn: "x", csid: "y" },
      ),
    });
    assert.equal(res.status, 404, `${path} must be non-disclosing`);
  }

  // A receivable invoice is not a bill: the bill routes must not touch it.
  const recv = await fetch(`${own}/bills/${recvDraftId}/payment-flag`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ status: "scheduled" }),
  });
  assert.equal(recv.status, 404, "a receivable 404s on the bill routes");

  // A foreign tenant's admin sees nothing.
  const cross = await fetch(`${foreign}/bills/${billOpenId}/payment-flag`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ status: "scheduled" }),
  });
  assert.equal(cross.status, 404, "cross-tenant is non-disclosing");

  // The sibling's own bills list is simply empty — never clientParty's rows.
  const list = await fetch(`${sibling}/bills?clientPartyId=${clientParty}`);
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), []);
});

// ---------------------------------------------------------------------------
// Payment flags: evidence only, derived status flips, no transition
// ---------------------------------------------------------------------------

test("payer flags record evidence and flip the derived payStatus without any transition", async () => {
  const base = await listen(appFor(clientUser, billsRouter));

  const listStatus = async (id: string) => {
    const res = await fetch(`${base}/bills?clientPartyId=${clientParty}`);
    assert.equal(res.status, 200);
    const rows = (await res.json()) as { invoiceId: string; payStatus: string }[];
    return rows.find((r) => r.invoiceId === id)?.payStatus;
  };

  assert.equal(await listStatus(billFlagId), "open");

  // A malformed amount is a 400, not a DB error.
  const bad = await fetch(`${base}/bills/${billFlagId}/payment-flag`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ status: "paid", amount: "12,000" }),
  });
  assert.equal(bad.status, 400);

  const scheduled = await fetch(`${base}/bills/${billFlagId}/payment-flag`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ status: "scheduled" }),
  });
  assert.equal(scheduled.status, 201);
  const scheduledBody = (await scheduled.json()) as {
    source: string;
    paymentStatus: string;
    amount: string;
  };
  assert.equal(scheduledBody.source, "payer_flag");
  assert.equal(scheduledBody.paymentStatus, "scheduled");
  assert.equal(scheduledBody.amount, "150.00", "defaults to the grand total");
  assert.equal(await listStatus(billFlagId), "scheduled");

  const paid = await fetch(`${base}/bills/${billFlagId}/payment-flag`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ status: "paid", amount: "150.00" }),
  });
  assert.equal(paid.status, 201);
  assert.equal(await listStatus(billFlagId), "paid");

  // The bill itself NEVER transitions: still a draft, evidence rows only.
  const [invoice] = await getDb()
    .select({ status: invoicesTable.status })
    .from(invoicesTable)
    .where(eq(invoicesTable.id, billFlagId));
  assert.equal(invoice.status, "draft", "bills never transition");
  const events = await getDb()
    .select()
    .from(settlementEventsTable)
    .where(eq(settlementEventsTable.invoiceId, billFlagId));
  assert.equal(events.length, 2, "append-only: one row per flag");
  assert.ok(events.every((e) => e.source === "payer_flag"));
});

// ---------------------------------------------------------------------------
// Verify-stamp: row persisted, known and unknown stamps
// ---------------------------------------------------------------------------

test("verify-stamp records the verification for known and unknown stamps", async () => {
  const base = await listen(appFor(admin, billsRouter));

  const known = await fetch(`${base}/bills/${billOpenId}/verify-stamp`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ irn: KNOWN_IRN, csid: KNOWN_CSID }),
  });
  assert.equal(known.status, 201);
  const knownBody = (await known.json()) as {
    invoiceId: string;
    valid: boolean;
    eligible: boolean | null;
  };
  assert.equal(knownBody.invoiceId, billOpenId);
  assert.equal(knownBody.valid, true);
  assert.equal(knownBody.eligible, true, "stamped lifecycle is eligible");

  const unknown = await fetch(`${base}/bills/${billOpenId}/verify-stamp`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ irn: `IRN-NOPE-${SALT}`, csid: "CSID-NOPE" }),
  });
  assert.equal(unknown.status, 201);
  const unknownBody = (await unknown.json()) as {
    valid: boolean;
    eligible: boolean | null;
  };
  assert.equal(unknownBody.valid, false);
  assert.equal(
    unknownBody.eligible,
    null,
    "an unknown stamp has no lifecycle to be eligible against",
  );

  const rows = await getDb()
    .select()
    .from(billVerificationsTable)
    .where(eq(billVerificationsTable.invoiceId, billOpenId));
  assert.equal(rows.length, 2, "every check persists");
  assert.ok(rows.every((r) => r.firmId === firmA));
  assert.ok(rows.every((r) => r.checkedByUserId === adminId));

  // The ledger surfaces the NEWEST verification.
  const list = await fetch(`${base}/bills?clientPartyId=${clientParty}`);
  const bills = (await list.json()) as {
    invoiceId: string;
    lastVerification: { valid: boolean } | null;
  }[];
  const open = bills.find((b) => b.invoiceId === billOpenId);
  assert.equal(open?.lastVerification?.valid, false, "newest check wins");
});

// ---------------------------------------------------------------------------
// Payables summary buckets
// ---------------------------------------------------------------------------

test("the payables summary buckets unpaid bills by due date with top suppliers", async () => {
  const base = await listen(appFor(admin, billsRouter));
  const res = await fetch(
    `${base}/dashboard/payables?clientPartyId=${summaryClient}`,
  );
  assert.equal(res.status, 200);
  const summary = (await res.json()) as {
    clientPartyId: string;
    groups: {
      currency: string;
      overdue: { amount: string; count: number };
      dueWeeks: { amount: string; count: number }[];
      later: { amount: string; count: number };
      total: { amount: string; count: number };
    }[];
    topSuppliers: { supplierName: string; amount: string; count: number }[];
  };
  assert.equal(summary.clientPartyId, summaryClient);
  assert.equal(summary.groups.length, 1);
  const g = summary.groups[0];
  assert.equal(g.currency, "NGN");
  assert.equal(g.total.count, 4, "the paid bill is out of every bucket");
  assert.equal(g.total.amount, "1500.00");
  assert.deepEqual(g.overdue, { amount: "400.00", count: 1 });
  assert.equal(g.dueWeeks.length, 4);
  assert.deepEqual(
    g.dueWeeks.map((w) => w.count),
    [1, 1, 0, 0],
    "due +2 is week 0, due +9 is week 1",
  );
  assert.deepEqual(g.later, { amount: "800.00", count: 1 }, "no due date -> later");
  assert.equal(summary.topSuppliers.length, 1);
  assert.equal(summary.topSuppliers[0].supplierName, `Bills Vendor ${SALT}`);
  assert.equal(summary.topSuppliers[0].amount, "1500.00");
  assert.equal(summary.topSuppliers[0].count, 4);
});

// ---------------------------------------------------------------------------
// Submit guard
// ---------------------------------------------------------------------------

test("a bill 409s NOT_SUBMITTABLE on validate, submit and credit-note; a receivable still submits", async () => {
  const base = await listen(appFor(admin, invoicesRouter));

  for (const action of ["validate", "submit"]) {
    const res = await fetch(`${base}/invoices/${billOpenId}/${action}`, {
      method: "POST",
      headers: JSON_HEADERS,
    });
    assert.equal(res.status, 409, `${action} must refuse a bill`);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /supplier is not a client of your practice/);
  }

  const cn = await fetch(`${base}/invoices/${billOpenId}/credit-note`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ reason: "not ours" }),
  });
  assert.equal(cn.status, 409, "the credit-note path inherits the guard");
  assert.match(
    ((await cn.json()) as { error: string }).error,
    /supplier is not a client of your practice/,
  );

  // The invoice row is untouched by the refusals.
  const [bill] = await getDb()
    .select({ status: invoicesTable.status })
    .from(invoicesTable)
    .where(eq(invoicesTable.id, billOpenId));
  assert.equal(bill.status, "draft");

  // Control: the receivable draft still validates and submits.
  const validate = await fetch(`${base}/invoices/${recvDraftId}/validate`, {
    method: "POST",
    headers: JSON_HEADERS,
  });
  assert.equal(validate.status, 200);
  assert.equal(((await validate.json()) as { ok: boolean }).ok, true);
  const submit = await fetch(`${base}/invoices/${recvDraftId}/submit`, {
    method: "POST",
    headers: JSON_HEADERS,
  });
  assert.equal(submit.status, 202);
});

// ---------------------------------------------------------------------------
// SME calendar: bill_due deadlines
// ---------------------------------------------------------------------------

test("the compliance calendar carries bill_due deadlines for unpaid due bills", async () => {
  const base = await listen(appFor(admin, smeRouter));
  const res = await fetch(
    `${base}/compliance/calendar?clientPartyId=${clientParty}`,
  );
  assert.equal(res.status, 200);
  const deadlines = (await res.json()) as {
    kind: string;
    invoiceId: string | null;
    status: string;
    severity: string;
    title: string;
  }[];
  const billDue = deadlines.filter((d) => d.kind === "bill_due");
  assert.ok(
    billDue.some((d) => d.invoiceId === billOpenId),
    "the open bill is on the calendar",
  );
  const open = billDue.find((d) => d.invoiceId === billOpenId)!;
  assert.equal(open.status, "upcoming", "due in 5 days");
  assert.equal(open.severity, "info");
  assert.match(open.title, /Pay bill/);
  assert.ok(
    !billDue.some((d) => d.invoiceId === billFlagId),
    "a paid bill leaves the calendar",
  );
  // Bills never appear as submission deadlines (orientation hygiene).
  assert.ok(
    !deadlines.some(
      (d) =>
        (d.kind === "invoice_submission" || d.kind === "penalty_watch") &&
        (d.invoiceId === billOpenId || d.invoiceId === billFlagId),
    ),
  );
});
