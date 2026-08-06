import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  getDb,
  engagementsTable,
  firmsTable,
  invoicesTable,
  partiesTable,
} from "@workspace/db";
import { DomainError } from "../errors.ts";
import whtRouter from "../../routes/wht.ts";
import { computeWhtRemittance } from "./remittance.ts";
import {
  appFor,
  listen,
  closeAllServers,
} from "../../test-helpers/route-harness.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";
import { clientPrincipal, firmPrincipal } from "../../test-helpers/principals.ts";

// The withholding remittance schedule (WHT Desk): the client's BILLS
// (buyer-side, the BILL_OF_CLIENT orientation) carrying a WHT category and
// issued inside the period, each with the SQL-computed deduction, due the
// 21st of the following month. Frozen far-future period so every assertion
// is exact whatever today is — and clear of anything the mint sweep creates.

const SALT = makeRunSalt();

const firmId = randomUUID();
const clientParty = randomUUID(); // the buyer of the bills — the remitter
const siblingParty = randomUUID(); // engaged sibling (SEC-03 probe)
const vendorA = randomUUID(); // not engaged — supplier of the bills
const vendorB = randomUUID();

const PERIOD = "2097-07";

before(async () => {
  const db = getDb();
  await db.insert(firmsTable).values({ id: firmId, name: `WHT Remit Firm ${SALT}` });
  await db.insert(partiesTable).values([
    { id: clientParty, type: "client_business", legalName: `WHT Remit Client ${SALT}` },
    { id: siblingParty, type: "client_business", legalName: `WHT Remit Sibling ${SALT}` },
    { id: vendorA, type: "buyer", legalName: `Remit Vendor Alpha ${SALT}` },
    { id: vendorB, type: "buyer", legalName: `Remit Vendor Beta ${SALT}` },
  ]);
  await db.insert(engagementsTable).values([
    { firmId, clientPartyId: clientParty, type: "retainer", title: `wht rm A ${SALT}` },
    { firmId, clientPartyId: siblingParty, type: "retainer", title: `wht rm B ${SALT}` },
  ]);
  const bill = (
    supplier: string,
    invoiceNumber: string,
    issueDate: string,
    subtotal: string,
    whtCategory: string | null,
    over: Partial<typeof invoicesTable.$inferInsert> = {},
  ) => ({
    firmId,
    supplierPartyId: supplier,
    buyerPartyId: clientParty,
    invoiceNumber,
    status: "draft" as const,
    issueDate,
    subtotal,
    vatTotal: "0.00",
    grandTotal: subtotal,
    whtCategory,
    ...over,
  });
  await db.insert(invoicesTable).values([
    // In the period, categorised: the two schedule rows.
    bill(vendorA, `RM-SVC-${SALT}`, "2097-07-05", "200000.00", "services_5"),
    bill(vendorB, `RM-RENT-${SALT}`, "2097-07-20", "60000.00", "rent_10"),
    // In the period but uncategorised: no withholding, no row.
    bill(vendorA, `RM-NOCAT-${SALT}`, "2097-07-10", "80000.00", null),
    // Categorised but OUTSIDE the period.
    bill(vendorA, `RM-JUNE-${SALT}`, "2097-06-28", "50000.00", "services_5"),
    // Cancelled in the period: never remitted on.
    bill(vendorB, `RM-CXL-${SALT}`, "2097-07-12", "70000.00", "goods_2", {
      status: "cancelled" as const,
    }),
    // The client's OWN receivable carrying a category (client is the
    // SUPPLIER): not a bill — the buyer withholds on it, not the client.
    {
      firmId,
      supplierPartyId: clientParty,
      buyerPartyId: vendorA,
      invoiceNumber: `RM-RECV-${SALT}`,
      status: "stamped" as const,
      issueDate: "2097-07-15",
      subtotal: "90000.00",
      vatTotal: "0.00",
      grandTotal: "90000.00",
      whtCategory: "services_5",
    },
  ]);
});

after(async () => {
  await closeAllServers();
});

test("the schedule: in-period categorised bills, computed deductions, the 21st", async () => {
  const schedule = await computeWhtRemittance(firmId, clientParty, PERIOD);
  assert.equal(schedule.period, PERIOD);
  assert.equal(schedule.periodLabel, "July 2097");
  assert.equal(schedule.dueDate, "2097-08-21", "the wht 21st from the shared calendar");
  assert.deepEqual(schedule.rows, [
    {
      invoiceId: schedule.rows[0].invoiceId,
      invoiceNumber: `RM-SVC-${SALT}`,
      vendorName: `Remit Vendor Alpha ${SALT}`,
      category: "services_5",
      baseAmount: "200000.00",
      whtAmount: "10000.00", // 5% of the VAT-exclusive base
      issueDate: "2097-07-05",
    },
    {
      invoiceId: schedule.rows[1].invoiceId,
      invoiceNumber: `RM-RENT-${SALT}`,
      vendorName: `Remit Vendor Beta ${SALT}`,
      category: "rent_10",
      baseAmount: "60000.00",
      whtAmount: "6000.00", // 10%
      issueDate: "2097-07-20",
    },
  ]);
  // Totals summed FROM the rows.
  assert.deepEqual(schedule.totals, { bills: 2, whtAmount: "16000.00" });
});

test("an empty period answers an empty schedule; a bad period is refused", async () => {
  const empty = await computeWhtRemittance(firmId, clientParty, "2097-09");
  assert.deepEqual(empty.rows, []);
  assert.deepEqual(empty.totals, { bills: 0, whtAmount: "0.00" });
  assert.equal(empty.dueDate, "2097-10-21");

  // The sibling has no bills at all.
  const sibling = await computeWhtRemittance(firmId, siblingParty, PERIOD);
  assert.deepEqual(sibling.rows, []);

  await assert.rejects(
    computeWhtRemittance(firmId, clientParty, "2097-13"),
    (err: unknown) =>
      err instanceof DomainError &&
      err.code === "WHT_BAD_PERIOD" &&
      err.status === 400,
  );
});

test("the route requires clientPartyId, pins a client_user, serves the schedule", async () => {
  const base = await listen(appFor(firmPrincipal(firmId), whtRouter));
  const res = await fetch(
    `${base}/wht/remittance?clientPartyId=${clientParty}&period=${PERIOD}`,
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    dueDate: string;
    rows: unknown[];
    totals: { bills: number; whtAmount: string };
  };
  assert.equal(body.dueDate, "2097-08-21");
  assert.equal(body.rows.length, 2);
  assert.deepEqual(body.totals, { bills: 2, whtAmount: "16000.00" });

  // Missing clientPartyId: contract-invalid, 400.
  const missing = await fetch(`${base}/wht/remittance`);
  assert.equal(missing.status, 400);

  // A client_user asking for a SIBLING's schedule: CROSS_CLIENT (403).
  const clientBase = await listen(
    appFor(clientPrincipal(firmId, siblingParty), whtRouter),
  );
  const walled = await fetch(
    `${clientBase}/wht/remittance?clientPartyId=${clientParty}&period=${PERIOD}`,
  );
  assert.equal(walled.status, 403);
  // Its OWN schedule answers.
  const own = await fetch(
    `${clientBase}/wht/remittance?clientPartyId=${siblingParty}&period=${PERIOD}`,
  );
  assert.equal(own.status, 200);
});
