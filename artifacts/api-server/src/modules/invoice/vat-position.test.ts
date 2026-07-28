import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import {
  getDb,
  billVerificationsTable,
  engagementsTable,
  firmsTable,
  invoicesTable,
  partiesTable,
  submissionAttemptsTable,
} from "@workspace/db";
import vatPositionRouter from "../../routes/vat-position.ts";
import {
  computeFirmVatPositions,
  computeVatPosition,
  listVatPositionDocuments,
  vatPositionMonths,
} from "./vat-position.ts";
import type { Principal } from "../auth/rbac.ts";
import {
  appFor,
  listen,
  closeAllServers,
} from "../../test-helpers/route-harness.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Monthly VAT position (contract 0.45.0). Pinned here:
//  - the OUTPUT basis mirrors the VAT pack: only rails-accepted documents in
//    the issue month count, credit notes are netted, cancelled and never-
//    accepted paper is out;
//  - the INPUT basis is the captured bills (all statuses except cancelled —
//    bills are draft for life), split by the NEWEST verification's validity;
//  - FX: NGN face value, non-NGN converts at the captured rate, and a
//    non-NGN document WITHOUT a rate is excluded from every total and
//    counted in excludedForFx — never assumed at rate 1;
//  - the firm rollup enumerates open/in_progress engagements only and its
//    totals equal its summed rows;
//  - the routes: SEC-03 pinning for client_users, BAD_MONTH 400 for a month
//    off the live 12-month list, and the CSV export's signed per-document
//    rows with the trailing disclosure note.

const SALT = makeRunSalt();
const firmA = randomUUID();
const firmB = randomUUID();
const clientOne = randomUUID(); // engaged, all the activity
const clientTwo = randomUUID(); // engaged, zero activity (the zero row)
const archivedClient = randomUUID(); // archived engagement — off the rollup
const vendorParty = randomUUID(); // NOT engaged — the bills' supplier
const buyerParty = randomUUID(); // plain buyer on the output documents
const foreignClient = randomUUID(); // firm B's client — isolation probe
const adminId = randomUUID();

const admin: Principal = {
  userId: adminId,
  role: "firm_admin",
  firmId: firmA,
  clientPartyId: null,
  buyerPartyId: null,
};
const siblingUser: Principal = {
  userId: randomUUID(),
  role: "client_user",
  firmId: firmA,
  clientPartyId: clientTwo,
  buyerPartyId: null,
};

// The current Lagos month (the default position month) and its predecessor;
// fixed mid-month issue dates so a month rollover mid-run cannot flip a
// window boundary.
const MONTHS = vatPositionMonths();
const MONTH = MONTHS[0];
const midMonth = (monthStart: string) => `${monthStart.slice(0, 8)}15`;

const OUT_NGN = `VP-OUT-NGN-${SALT}`;
const OUT_CN = `VP-OUT-CN-${SALT}`;
const OUT_USD = `VP-OUT-USD-${SALT}`;
const OUT_NOFX = `VP-OUT-NOFX-${SALT}`;
const OUT_UNACCEPTED = `VP-OUT-UNACC-${SALT}`;
const OUT_CANCELLED = `VP-OUT-CANC-${SALT}`;
const OUT_PRIOR = `VP-OUT-PRIOR-${SALT}`;
const BILL_VERIFIED = `VP-BILL-VER-${SALT}`;
const BILL_INVALID = `VP-BILL-INV-${SALT}`;
const BILL_UNVERIFIED = `VP-BILL-UNV-${SALT}`;
const BILL_NOFX = `VP-BILL-NOFX-${SALT}`;
const BILL_CANCELLED = `VP-BILL-CANC-${SALT}`;
const RECV_ORIENTED = `VP-RECV-${SALT}`;
const FOREIGN_NUM = `VP-FOREIGN-${SALT}`;

before(async () => {
  const db = getDb();
  await db.insert(firmsTable).values([
    { id: firmA, name: `VatPos Firm A ${SALT}` },
    { id: firmB, name: `VatPos Firm B ${SALT}` },
  ]);
  await db.insert(partiesTable).values([
    { id: clientOne, type: "client_business", legalName: `VatPos A ${SALT}` },
    { id: clientTwo, type: "client_business", legalName: `VatPos B ${SALT}` },
    {
      id: archivedClient,
      type: "client_business",
      legalName: `VatPos C ${SALT}`,
    },
    { id: vendorParty, type: "buyer", legalName: `VatPos Vendor ${SALT}` },
    { id: buyerParty, type: "buyer", legalName: `VatPos Buyer ${SALT}` },
    {
      id: foreignClient,
      type: "client_business",
      legalName: `VatPos Foreign ${SALT}`,
    },
  ]);
  await db.insert(engagementsTable).values([
    {
      firmId: firmA,
      clientPartyId: clientOne,
      type: "retainer",
      title: `vp A ${SALT}`,
    },
    {
      firmId: firmA,
      clientPartyId: clientTwo,
      type: "retainer",
      title: `vp B ${SALT}`,
    },
    {
      firmId: firmA,
      clientPartyId: archivedClient,
      type: "retainer",
      title: `vp C ${SALT}`,
      status: "archived",
    },
    {
      firmId: firmB,
      clientPartyId: foreignClient,
      type: "retainer",
      title: `vp F ${SALT}`,
    },
  ]);

  type InvoiceSeed = typeof invoicesTable.$inferInsert;
  const doc = (
    over: Partial<InvoiceSeed> & Pick<InvoiceSeed, "invoiceNumber">,
  ): InvoiceSeed => ({
    firmId: firmA,
    supplierPartyId: clientOne,
    buyerPartyId: buyerParty,
    status: "submitted",
    issueDate: midMonth(MONTH),
    ...over,
  });
  const accepted: string[] = [];
  const withId = (over: Parameters<typeof doc>[0]): InvoiceSeed => {
    const id = randomUUID();
    accepted.push(id);
    return doc({ id, ...over });
  };
  await db.insert(invoicesTable).values([
    // OUTPUT side. Accepted NGN invoice: +100.00.
    withId({ invoiceNumber: OUT_NGN, vatTotal: "100.00", grandTotal: "1100.00" }),
    // Accepted NGN credit note: netted, -30.00.
    withId({ invoiceNumber: OUT_CN, kind: "credit_note", vatTotal: "30.00" }),
    // Accepted USD invoice with a captured rate: 2.00 * 1500 = +3000.00.
    withId({
      invoiceNumber: OUT_USD,
      currency: "USD",
      fxRateToNgn: "1500",
      vatTotal: "2.00",
    }),
    // Accepted EUR invoice with NO rate: excluded, counted in excludedForFx.
    withId({ invoiceNumber: OUT_NOFX, currency: "EUR", vatTotal: "50.00" }),
    // Cancelled (despite an accepted attempt): void whatever the rails said.
    withId({
      invoiceNumber: OUT_CANCELLED,
      status: "cancelled",
      vatTotal: "77.00",
    }),
    // Accepted but issued in the PRIOR month: outside this month's window.
    withId({
      invoiceNumber: OUT_PRIOR,
      issueDate: midMonth(MONTHS[1]),
      vatTotal: "88.00",
    }),
    // Never accepted: unsubmitted paper is not evidence (no attempt row).
    doc({ invoiceNumber: OUT_UNACCEPTED, status: "draft", vatTotal: "999.00" }),
    // INPUT side: captured bills (vendor supplies, the client pays). Draft
    // forever; no attempt rows.
    ...[
      { invoiceNumber: BILL_VERIFIED, vatTotal: "40.00" },
      { invoiceNumber: BILL_INVALID, vatTotal: "25.00" },
      { invoiceNumber: BILL_UNVERIFIED, vatTotal: "10.00" },
      {
        invoiceNumber: BILL_NOFX,
        currency: "USD" as const,
        vatTotal: "5.00",
      },
      {
        invoiceNumber: BILL_CANCELLED,
        status: "cancelled" as const,
        vatTotal: "60.00",
      },
    ].map((b) =>
      doc({
        supplierPartyId: vendorParty,
        buyerPartyId: clientOne,
        status: "draft",
        ...b,
      }),
    ),
    // Engaged on BOTH sides: the supplier side wins (receivable), so this is
    // NOT clientOne's bill — orientation hygiene.
    doc({
      invoiceNumber: RECV_ORIENTED,
      supplierPartyId: clientTwo,
      buyerPartyId: clientOne,
      status: "draft",
      vatTotal: "500.00",
    }),
    // Firm B's accepted invoice: must never bleed into firm A's numbers.
    withId({
      invoiceNumber: FOREIGN_NUM,
      firmId: firmB,
      supplierPartyId: foreignClient,
      vatTotal: "600.00",
    }),
  ]);
  await db.insert(submissionAttemptsTable).values(
    accepted.map((invoiceId, n) => ({
      invoiceId,
      rail: "rail_primary" as const,
      attemptNo: 1,
      idempotencyKey: `vp-${SALT}-${n}`,
      status: "accepted" as const,
    })),
  );

  // Verifications: the NEWEST row (checked_at DESC) decides. BILL_VERIFIED
  // flips invalid -> valid; BILL_INVALID flips valid -> invalid;
  // BILL_UNVERIFIED has none at all.
  const idByNumber = new Map(
    (
      await db
        .select({
          id: invoicesTable.id,
          invoiceNumber: invoicesTable.invoiceNumber,
        })
        .from(invoicesTable)
        .where(
          inArray(invoicesTable.invoiceNumber, [BILL_VERIFIED, BILL_INVALID]),
        )
    ).map((r) => [r.invoiceNumber, r.id]),
  );
  const older = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  const newer = new Date();
  const check = (
    invoiceNumber: string,
    valid: boolean,
    checkedAt: Date,
  ): typeof billVerificationsTable.$inferInsert => ({
    firmId: firmA,
    invoiceId: idByNumber.get(invoiceNumber)!,
    irn: `IRN-${invoiceNumber}`,
    csid: `CSID-${invoiceNumber}`,
    valid,
    checkedByUserId: adminId,
    checkedAt,
  });
  await db.insert(billVerificationsTable).values([
    check(BILL_VERIFIED, false, older),
    check(BILL_VERIFIED, true, newer),
    check(BILL_INVALID, true, older),
    check(BILL_INVALID, false, newer),
  ]);
});

after(async () => {
  await closeAllServers();
});

test("computeVatPosition assembles every contract field from the two bases", async () => {
  const position = await computeVatPosition(firmA, clientOne, MONTH);
  assert.equal(position.clientPartyId, clientOne);
  assert.equal(position.monthStart, MONTH);
  assert.ok(position.monthLabel.includes(MONTH.slice(0, 4)));
  // The live option list: 12 Lagos months, newest (current) first.
  assert.equal(position.months.length, 12);
  assert.equal(position.months[0], MONTH);
  assert.deepEqual(position.months, vatPositionMonths());
  // Output: 100 (NGN) - 30 (credit note) + 3000 (USD at 1500) = 3070.00;
  // the no-rate EUR invoice, the cancelled, the prior-month and the
  // never-accepted documents all stay out.
  assert.equal(position.outputVat, "3070.00");
  assert.equal(position.outputInvoiceCount, 2);
  // Input: 40 (verified) + 25 (newest check invalid) + 10 (never checked);
  // the no-rate USD bill and the cancelled bill stay out, and the
  // both-sides-engaged document is a receivable, not a bill.
  assert.equal(position.inputVat, "75.00");
  assert.equal(position.inputVatVerified, "40.00");
  assert.equal(position.inputVatUnverified, "35.00");
  assert.equal(position.billCount, 3);
  assert.equal(position.netVat, "2995.00");
  assert.equal(position.defensibleNetVat, "3030.00");
  // One excluded output document + one excluded bill.
  assert.equal(position.excludedForFx, 2);
  assert.match(position.note, /accepted submission attempt/);
  assert.match(position.note, /NEWEST stamp verification/);
  assert.match(position.note, /excludedForFx/);
  assert.match(position.note, /never assumed/);
});

test("computeFirmVatPositions enumerates open engagements and its totals equal its rows", async () => {
  const firm = await computeFirmVatPositions(firmA, MONTH);
  assert.equal(firm.monthStart, MONTH);
  assert.deepEqual(firm.months, vatPositionMonths());
  // clientOne and clientTwo (open engagements) — never the archived client.
  assert.deepEqual(
    firm.rows.map((r) => r.clientPartyId),
    [clientOne, clientTwo],
    "name-ordered open/in_progress clients only",
  );
  const [one, two] = firm.rows;
  assert.equal(one.clientName, `VatPos A ${SALT}`);
  // The rollup row must equal the per-client position field for field.
  const position = await computeVatPosition(firmA, clientOne, MONTH);
  assert.equal(one.outputVat, position.outputVat);
  assert.equal(one.inputVat, position.inputVat);
  assert.equal(one.inputVatVerified, position.inputVatVerified);
  assert.equal(one.netVat, position.netVat);
  assert.equal(one.defensibleNetVat, position.defensibleNetVat);
  // A quiet client is an explicit zero row, not a missing one.
  assert.deepEqual(two, {
    clientPartyId: clientTwo,
    clientName: `VatPos B ${SALT}`,
    outputVat: "0.00",
    inputVat: "0.00",
    inputVatVerified: "0.00",
    netVat: "0.00",
    defensibleNetVat: "0.00",
  });
  // Totals summed from the rows — and firm B's paper never bled in.
  for (const key of [
    "outputVat",
    "inputVat",
    "inputVatVerified",
    "netVat",
    "defensibleNetVat",
  ] as const) {
    const summed = firm.rows
      .reduce((sum, r) => sum + Number(r[key]), 0)
      .toFixed(2);
    assert.equal(firm.totals[key], summed, `totals.${key} equals its column`);
  }
  assert.equal(firm.totals.outputVat, "3070.00");
});

test("listVatPositionDocuments carries signed NGN values and the verified posture", async () => {
  const docs = await listVatPositionDocuments(firmA, clientOne, MONTH);
  const byNumber = new Map(docs.map((d) => [d.invoiceNumber, d]));
  assert.equal(docs.length, 8, "4 output documents + 4 bills");
  assert.equal(byNumber.get(OUT_CN)?.docType, "credit_note");
  assert.equal(byNumber.get(OUT_CN)?.vatNgn, "-30.00", "credit notes signed");
  assert.equal(byNumber.get(OUT_CN)?.vatOriginal, "30.00");
  assert.equal(byNumber.get(OUT_USD)?.vatNgn, "3000.00");
  assert.equal(byNumber.get(OUT_NOFX)?.vatNgn, null, "no rate -> excluded");
  assert.equal(byNumber.get(OUT_NGN)?.verified, null, "output docs: blank");
  assert.equal(byNumber.get(BILL_VERIFIED)?.docType, "bill");
  assert.equal(byNumber.get(BILL_VERIFIED)?.verified, true);
  assert.equal(byNumber.get(BILL_INVALID)?.verified, false, "newest wins");
  assert.equal(byNumber.get(BILL_UNVERIFIED)?.verified, false);
  assert.equal(byNumber.get(BILL_NOFX)?.vatNgn, null);
  assert.equal(
    byNumber.get(BILL_VERIFIED)?.counterparty,
    `VatPos Vendor ${SALT}`,
  );
  // The signed columns reproduce the position exactly, per side.
  const sum = (filter: (d: (typeof docs)[number]) => boolean) =>
    docs
      .filter((d) => filter(d) && d.vatNgn !== null)
      .reduce((s, d) => s + Number(d.vatNgn), 0)
      .toFixed(2);
  assert.equal(sum((d) => d.docType !== "bill"), "3070.00");
  assert.equal(sum((d) => d.docType === "bill"), "75.00");
});

test("GET /vat-position answers the scoped position and refuses a bad month", async () => {
  const base = await listen(appFor(admin, vatPositionRouter));
  const res = await fetch(
    `${base}/vat-position?clientPartyId=${clientOne}&month=${MONTH}`,
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    clientPartyId: string;
    outputVat: string;
    netVat: string;
    excludedForFx: number;
  };
  assert.equal(body.clientPartyId, clientOne);
  assert.equal(body.outputVat, "3070.00");
  assert.equal(body.netVat, "2995.00");
  assert.equal(body.excludedForFx, 2);

  // Omitted month defaults to the current Lagos month.
  const defaulted = await fetch(`${base}/vat-position?clientPartyId=${clientOne}`);
  assert.equal(defaulted.status, 200);
  assert.equal(
    ((await defaulted.json()) as { monthStart: string }).monthStart,
    MONTH,
  );

  // A well-formed month off the live 12-month list is a BAD_MONTH 400.
  const stale = await fetch(
    `${base}/vat-position?clientPartyId=${clientOne}&month=2019-01-01`,
  );
  assert.equal(stale.status, 400);
  assert.match(
    ((await stale.json()) as { error: string }).error,
    /last 12 Lagos months/,
  );
});

test("a client_user is pinned to its own party — a sibling id never answers (SEC-03)", async () => {
  const base = await listen(appFor(siblingUser, vatPositionRouter));
  // Naming the sibling's party returns the CALLER's own (quiet) position.
  const res = await fetch(`${base}/vat-position?clientPartyId=${clientOne}`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    clientPartyId: string;
    outputVat: string;
    inputVat: string;
  };
  assert.equal(body.clientPartyId, clientTwo, "pinned to the caller's party");
  assert.equal(body.outputVat, "0.00");
  assert.equal(body.inputVat, "0.00");
  // The firm rollup is a firm surface: client_users lack the capability.
  const rollup = await fetch(`${base}/console/vat-positions`);
  assert.equal(rollup.status, 403);
});

test("GET /vat-position/export ships the per-document CSV with the note row", async () => {
  const base = await listen(appFor(admin, vatPositionRouter));
  const res = await fetch(
    `${base}/vat-position/export?clientPartyId=${clientOne}&month=${MONTH}`,
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/csv/);
  assert.equal(
    res.headers.get("content-disposition"),
    `attachment; filename="vat-position-${MONTH.slice(0, 7)}.csv"`,
  );
  const csv = await res.text();
  const lines = csv.split("\r\n").filter((l) => l.length > 0);
  assert.match(lines[0], /^﻿?docType,invoiceNumber,counterparty,currency,fxRateToNgn,vatOriginal,vatNgn,verified$/);
  const cell = (line: string) => line.split(",");
  const cnLine = lines.find((l) => l.includes(OUT_CN));
  assert.ok(cnLine, "credit note row present");
  assert.equal(cell(cnLine)[6], "'-30.00", "signed and formula-guarded");
  const verLine = lines.find((l) => l.includes(BILL_VERIFIED));
  assert.equal(cell(verLine ?? "")[7], "yes");
  const invLine = lines.find((l) => l.includes(BILL_INVALID));
  assert.equal(cell(invLine ?? "")[7], "no");
  const noFxLine = lines.find((l) => l.includes(BILL_NOFX));
  assert.equal(cell(noFxLine ?? "")[6], "", "excluded bill ships a blank NGN cell");
  const outLine = lines.find((l) => l.includes(OUT_NGN));
  assert.equal(cell(outLine ?? "")[7], "", "verified is blank on output docs");
  // The disclosure travels WITH the file.
  assert.match(csv, /A preparation aid, not a return/);

  const bad = await fetch(
    `${base}/vat-position/export?clientPartyId=${clientOne}&month=2019-01-01`,
  );
  assert.equal(bad.status, 400);
});

test("GET /console/vat-positions serves the firm rollup with month discipline", async () => {
  const base = await listen(appFor(admin, vatPositionRouter));
  const res = await fetch(`${base}/console/vat-positions?month=${MONTH}`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    monthStart: string;
    rows: { clientPartyId: string; outputVat: string }[];
    totals: { outputVat: string; defensibleNetVat: string };
  };
  assert.equal(body.monthStart, MONTH);
  assert.deepEqual(
    body.rows.map((r) => r.clientPartyId),
    [clientOne, clientTwo],
  );
  assert.equal(body.totals.outputVat, "3070.00");
  assert.equal(body.totals.defensibleNetVat, "3030.00");

  const bad = await fetch(`${base}/console/vat-positions?month=1999-05-01`);
  assert.equal(bad.status, 400);
  assert.match(
    ((await bad.json()) as { error: string }).error,
    /last 12 Lagos months/,
  );
});
