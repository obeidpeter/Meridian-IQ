import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import {
  getDb,
  auditEventsTable,
  consentRecordsTable,
  engagementsTable,
  firmPoliciesTable,
  firmsTable,
  invoiceApprovalsTable,
  invoicesTable,
  partiesTable,
  usersTable,
  type Invoice,
} from "@workspace/db";
import invoicesRouter from "../../routes/invoices/index.ts";
import firmPoliciesRouter from "../../routes/firm-policies.ts";
import {
  createDraft,
  submitInvoice,
  updateInvoiceContent,
} from "./service.ts";
import {
  firmSubmitApprovalRequired,
  listApprovals,
  recordApproval,
  updateFirmPolicies,
} from "./approvals.ts";
import { bulkSubmit } from "./bulk-submit.ts";
import { can, type Principal } from "../auth/rbac.ts";
import { parseCsv } from "../../lib/csv.ts";
import { isDomainError } from "../../test-helpers/assertions.ts";
import {
  appFor,
  listen,
  closeAllServers,
  JSON_HEADERS,
} from "../../test-helpers/route-harness.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Maker-checker submission approval + FX capture (contract 0.45.0). Pinned:
//  - the policy DEFAULTS OFF: with no firm_policies row a single actor still
//    submits alone — the regression that keeps every existing flow green;
//  - policy on: submit 409s APPROVAL_REQUIRED; a SELF-approval never counts;
//    a colleague's live approval clears the submit; the actor-less
//    system/worker path accepts any live approval;
//  - approvals are evidence: a content edit REVOKES (never deletes) them and
//    the submit closes again;
//  - approving a bill is the same 409 NOT_SUBMITTABLE a submit would earn;
//    post-submission paper (stamped) is APPROVAL_BAD_STATE;
//  - firm policies upsert in place (one row per firm), firm_admin-only write;
//  - fx: a valid rate persists on create/update, NGN + rate and malformed
//    rates are refused, and the CSV export appends fxRateToNgn/ngnEquivalent.

const SALT = makeRunSalt();
const firmOff = randomUUID(); // policy never set — the default-off regression
const firmOn = randomUUID(); // policy switched on in before()
const firmToggle = randomUUID(); // isolated upsert round-trip probes
const makerId = randomUUID();
const checkerId = randomUUID();
const clientOff = randomUUID(); // engaged with firmOff, consented
const clientOn = randomUUID(); // engaged with firmOn, consented
const clientBulk = randomUUID(); // engaged with firmOn — bulk-submit probe
const vendorParty = randomUUID(); // NOT engaged — the bill's supplier
const buyerParty = randomUUID();

const makerOn: Principal = {
  userId: makerId,
  role: "firm_admin",
  firmId: firmOn,
  clientPartyId: null,
  buyerPartyId: null,
};
const checkerOn: Principal = {
  ...makerOn,
  userId: checkerId,
  role: "firm_staff",
};
const makerOff: Principal = { ...makerOn, firmId: firmOff };
const adminToggle: Principal = { ...makerOn, firmId: firmToggle };
const staffToggle: Principal = {
  ...adminToggle,
  userId: checkerId,
  role: "firm_staff",
};

// A receivable that can go straight to submit: status validated (skips
// canonical validation, which is not under test), supplier engaged+consented.
async function seedValidated(
  firmId: string,
  supplierPartyId: string,
  invoiceNumber: string,
): Promise<string> {
  const id = randomUUID();
  await getDb().insert(invoicesTable).values({
    id,
    firmId,
    supplierPartyId,
    buyerPartyId: buyerParty,
    invoiceNumber,
    status: "validated",
    issueDate: "2026-07-01",
    subtotal: "1000.00",
    vatTotal: "75.00",
    grandTotal: "1075.00",
  });
  return id;
}

async function loadInvoice(id: string): Promise<Invoice> {
  const [row] = await getDb()
    .select()
    .from(invoicesTable)
    .where(eq(invoicesTable.id, id));
  return row;
}

let invOffId: string; // firmOff: single-actor regression
let invPolicyId: string; // firmOn: bare APPROVAL_REQUIRED probe
let invPairId: string; // firmOn: self-approval then colleague approval
let invWorkerId: string; // firmOn: actor-less system path
let invEditId: string; // firmOn: content edit revokes
let invBulkId: string; // firmOn/clientBulk: bulk-submit outcome
let billId: string; // firmOn: bill — approval must refuse
let stampedId: string; // firmOn: stamped — bad state

before(async () => {
  const db = getDb();
  await db
    .insert(usersTable)
    .values([
      {
        id: makerId,
        email: `appr-maker-${SALT}@test.local`,
        fullName: "Amaka Maker",
      },
      {
        id: checkerId,
        email: `appr-checker-${SALT}@test.local`,
        fullName: "Chidi Checker",
      },
    ])
    .onConflictDoNothing();
  await db.insert(firmsTable).values([
    { id: firmOff, name: `Approvals Firm Off ${SALT}` },
    { id: firmOn, name: `Approvals Firm On ${SALT}` },
    { id: firmToggle, name: `Approvals Firm Toggle ${SALT}` },
  ]);
  await db.insert(partiesTable).values([
    {
      id: clientOff,
      type: "client_business",
      legalName: `Approvals Client Off ${SALT}`,
    },
    {
      id: clientOn,
      type: "client_business",
      legalName: `Approvals Client On ${SALT}`,
    },
    {
      id: clientBulk,
      type: "client_business",
      legalName: `Approvals Client Bulk ${SALT}`,
    },
    { id: vendorParty, type: "buyer", legalName: `Approvals Vendor ${SALT}` },
    { id: buyerParty, type: "buyer", legalName: `Approvals Buyer ${SALT}` },
  ]);
  await db.insert(engagementsTable).values([
    { firmId: firmOff, clientPartyId: clientOff, type: "retainer", title: `ap-off ${SALT}` },
    { firmId: firmOn, clientPartyId: clientOn, type: "retainer", title: `ap-on ${SALT}` },
    { firmId: firmOn, clientPartyId: clientBulk, type: "retainer", title: `ap-bulk ${SALT}` },
  ]);
  // Layer-1 compliance consent so submits reach the approval guard, not the
  // consent gate.
  await db.insert(consentRecordsTable).values(
    [clientOff, clientOn, clientBulk].map((partyId) => ({
      partyId,
      layer: 1,
      action: "grant" as const,
      scope: "compliance_submission",
      basis: "contract",
      channel: "test",
    })),
  );

  invOffId = await seedValidated(firmOff, clientOff, `AP-OFF-${SALT}`);
  invPolicyId = await seedValidated(firmOn, clientOn, `AP-POL-${SALT}`);
  invPairId = await seedValidated(firmOn, clientOn, `AP-PAIR-${SALT}`);
  invWorkerId = await seedValidated(firmOn, clientOn, `AP-WORK-${SALT}`);
  invEditId = await seedValidated(firmOn, clientOn, `AP-EDIT-${SALT}`);
  invBulkId = await seedValidated(firmOn, clientBulk, `AP-BULK-${SALT}`);

  // A bill: supplier NOT engaged, buyer engaged (payables orientation).
  billId = randomUUID();
  await db.insert(invoicesTable).values({
    id: billId,
    firmId: firmOn,
    supplierPartyId: vendorParty,
    buyerPartyId: clientOn,
    invoiceNumber: `AP-BILL-${SALT}`,
    status: "draft",
    issueDate: "2026-07-01",
    grandTotal: "500.00",
    subtotal: "500.00",
  });
  // Post-submission paper: receivable-oriented but already stamped.
  stampedId = randomUUID();
  await db.insert(invoicesTable).values({
    id: stampedId,
    firmId: firmOn,
    supplierPartyId: clientOn,
    buyerPartyId: buyerParty,
    invoiceNumber: `AP-ST-${SALT}`,
    status: "stamped",
    issueDate: "2026-06-01",
    grandTotal: "700.00",
    subtotal: "700.00",
  });

  // Switch firmOn's policy on through the real module (also the first upsert).
  await updateFirmPolicies(firmOn, { submitApprovalRequired: true }, makerId);
});

after(async () => {
  await closeAllServers();
});

// ---------------------------------------------------------------------------
// Default off: nothing changes for existing firms
// ---------------------------------------------------------------------------

test("policy defaults off: a single actor still submits alone", async () => {
  assert.equal(await firmSubmitApprovalRequired(firmOff), false, "no row = off");
  const base = await listen(appFor(makerOff, invoicesRouter));
  const res = await fetch(`${base}/invoices/${invOffId}/submit`, {
    method: "POST",
    headers: JSON_HEADERS,
  });
  assert.equal(res.status, 202, "single-actor submit is untouched");
});

test("invoice.approve is firm-side dual control only", () => {
  assert.equal(can(makerOn, "invoice.approve"), true, "firm_admin approves");
  assert.equal(can(checkerOn, "invoice.approve"), true, "firm_staff approves");
  const clientUser: Principal = {
    userId: randomUUID(),
    role: "client_user",
    firmId: firmOn,
    clientPartyId: clientOn,
    buyerPartyId: null,
  };
  const operator: Principal = {
    userId: randomUUID(),
    role: "operator",
    firmId: null,
    clientPartyId: null,
    buyerPartyId: null,
  };
  assert.equal(can(clientUser, "invoice.approve"), false, "not client_user");
  assert.equal(can(operator, "invoice.approve"), false, "not operator");
});

// ---------------------------------------------------------------------------
// Policy on: the submit guard
// ---------------------------------------------------------------------------

test("policy on: submit without any approval 409s APPROVAL_REQUIRED", async () => {
  const base = await listen(appFor(makerOn, invoicesRouter));
  const res = await fetch(`${base}/invoices/${invPolicyId}/submit`, {
    method: "POST",
    headers: JSON_HEADERS,
  });
  assert.equal(res.status, 409);
  assert.match(
    ((await res.json()) as { error: string }).error,
    /second person's approval/,
  );
  await assert.rejects(
    submitInvoice(invPolicyId, makerId),
    isDomainError("APPROVAL_REQUIRED", 409),
  );
  assert.equal(
    (await loadInvoice(invPolicyId)).status,
    "validated",
    "the refusal leaves the invoice untouched",
  );
});

test("a self-approval never satisfies the submitter's own policy", async () => {
  const base = await listen(appFor(makerOn, invoicesRouter));
  // The maker approves its own invoice — recorded (it is valid evidence for
  // any OTHER submitter), body-less request included.
  const approve = await fetch(`${base}/invoices/${invPairId}/approve`, {
    method: "POST",
  });
  assert.equal(approve.status, 201);
  const approval = (await approve.json()) as {
    approvedByUserId: string;
    approvedByName: string | null;
    revokedAt: string | null;
  };
  assert.equal(approval.approvedByUserId, makerId);
  assert.equal(approval.approvedByName, "Amaka Maker");
  assert.equal(approval.revokedAt, null);

  const submit = await fetch(`${base}/invoices/${invPairId}/submit`, {
    method: "POST",
    headers: JSON_HEADERS,
  });
  assert.equal(submit.status, 409, "one human clicking twice is not dual control");
});

test("a colleague's approval clears the submit; the list is newest first", async () => {
  const checkerBase = await listen(appFor(checkerOn, invoicesRouter));
  const approve = await fetch(`${checkerBase}/invoices/${invPairId}/approve`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ note: "totals verified against the engagement" }),
  });
  assert.equal(approve.status, 201);
  const view = (await approve.json()) as {
    approvedByUserId: string;
    approvedByName: string | null;
    note: string | null;
  };
  assert.equal(view.approvedByUserId, checkerId);
  assert.equal(view.approvedByName, "Chidi Checker");
  assert.equal(view.note, "totals verified against the engagement");

  const makerBase = await listen(appFor(makerOn, invoicesRouter));
  const submit = await fetch(`${makerBase}/invoices/${invPairId}/submit`, {
    method: "POST",
    headers: JSON_HEADERS,
  });
  assert.equal(submit.status, 202, "a second person's live approval clears it");

  const list = await fetch(`${makerBase}/invoices/${invPairId}/approvals`);
  assert.equal(list.status, 200);
  const rows = (await list.json()) as { approvedByUserId: string }[];
  assert.equal(rows.length, 2, "both approvals are evidence");
  assert.equal(rows[0].approvedByUserId, checkerId, "newest first");
  assert.equal(rows[1].approvedByUserId, makerId);
});

test("the actor-less system path accepts any live approval", async () => {
  // Only the maker's own approval exists; a worker submit carries no actor,
  // so the human separation was enforced when the rows were recorded.
  await recordApproval(await loadInvoice(invWorkerId), makerId);
  const submitted = await submitInvoice(invWorkerId);
  assert.equal(submitted.status, "submitted");
});

// ---------------------------------------------------------------------------
// Content edits revoke
// ---------------------------------------------------------------------------

test("a content edit revokes live approvals and the submit closes again", async () => {
  await recordApproval(await loadInvoice(invEditId), checkerId);

  const base = await listen(appFor(makerOn, invoicesRouter));
  const patch = await fetch(`${base}/invoices/${invEditId}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({ notes: "quantity corrected after approval" }),
  });
  assert.equal(patch.status, 200);

  // Revoked, never deleted: the row survives with revokedAt stamped.
  const rows = await getDb()
    .select()
    .from(invoiceApprovalsTable)
    .where(eq(invoiceApprovalsTable.invoiceId, invEditId));
  assert.equal(rows.length, 1);
  assert.ok(rows[0].revokedAt, "the approval is revoked, not deleted");
  const views = await listApprovals(invEditId);
  assert.equal(typeof views[0].revokedAt, "string", "view carries the ISO stamp");

  const submit = await fetch(`${base}/invoices/${invEditId}/submit`, {
    method: "POST",
    headers: JSON_HEADERS,
  });
  assert.equal(submit.status, 409, "an approval never covers unseen content");
  assert.match(
    ((await submit.json()) as { error: string }).error,
    /second person's approval/,
  );
});

// ---------------------------------------------------------------------------
// Approval guards: orientation and state
// ---------------------------------------------------------------------------

test("approving a bill is the submit guard's own 409 NOT_SUBMITTABLE", async () => {
  await assert.rejects(
    recordApproval(await loadInvoice(billId), checkerId),
    isDomainError("NOT_SUBMITTABLE", 409),
  );
  const base = await listen(appFor(checkerOn, invoicesRouter));
  const res = await fetch(`${base}/invoices/${billId}/approve`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 409);
  assert.match(
    ((await res.json()) as { error: string }).error,
    /supplier is not a client of your practice/,
  );
});

test("approving post-submission paper is APPROVAL_BAD_STATE", async () => {
  await assert.rejects(
    recordApproval(await loadInvoice(stampedId), checkerId),
    isDomainError("APPROVAL_BAD_STATE", 409),
  );
  const base = await listen(appFor(checkerOn, invoicesRouter));
  const res = await fetch(`${base}/invoices/${stampedId}/approve`, {
    method: "POST",
  });
  assert.equal(res.status, 409);
  assert.match(((await res.json()) as { error: string }).error, /stamped/);
});

// ---------------------------------------------------------------------------
// Bulk submit: per-row APPROVAL_REQUIRED surfaces as outcome "failed"
// ---------------------------------------------------------------------------

test("bulk submit reports an unapproved row as failed with the approval message", async () => {
  const result = await bulkSubmit(clientBulk, firmOn, makerId);
  const row = result.rows.find((r) => r.invoiceId === invBulkId);
  assert.equal(row?.outcome, "failed");
  assert.match(row!.error ?? "", /second person's approval/);
  assert.equal(result.failedCount, 1);
  assert.equal(
    (await loadInvoice(invBulkId)).status,
    "validated",
    "a failed row is reported, not touched",
  );
});

// ---------------------------------------------------------------------------
// Firm policies: upsert round-trip, admin-only write
// ---------------------------------------------------------------------------

test("firm policies upsert in place and only a firm_admin may write", async () => {
  const staffBase = await listen(appFor(staffToggle, firmPoliciesRouter));
  const adminBase = await listen(appFor(adminToggle, firmPoliciesRouter));

  const initial = await fetch(`${staffBase}/firm/policies`);
  assert.equal(initial.status, 200);
  assert.deepEqual(await initial.json(), { submitApprovalRequired: false });

  // firm_staff read yes, write no (the integrations firmAdminScope posture).
  const forbidden = await fetch(`${staffBase}/firm/policies`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({ submitApprovalRequired: true }),
  });
  assert.equal(forbidden.status, 403);

  const on = await fetch(`${adminBase}/firm/policies`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({ submitApprovalRequired: true }),
  });
  assert.equal(on.status, 200);
  assert.deepEqual(await on.json(), { submitApprovalRequired: true });
  assert.equal(await firmSubmitApprovalRequired(firmToggle), true);

  const off = await fetch(`${adminBase}/firm/policies`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({ submitApprovalRequired: false }),
  });
  assert.equal(off.status, 200);
  assert.deepEqual(await off.json(), { submitApprovalRequired: false });

  // ONE row per firm across the whole round trip, stamped with the writer.
  const rows = await getDb()
    .select()
    .from(firmPoliciesTable)
    .where(eq(firmPoliciesTable.firmId, firmToggle));
  assert.equal(rows.length, 1, "upsert, not append");
  assert.equal(rows[0].submitApprovalRequired, false);
  assert.equal(rows[0].updatedByUserId, adminToggle.userId);

  // The write is audited with pointer-safe booleans.
  const [audit] = await getDb()
    .select()
    .from(auditEventsTable)
    .where(eq(auditEventsTable.action, "firm.policies_update"))
    .orderBy(desc(auditEventsTable.seq))
    .limit(1);
  assert.ok(audit);
  assert.deepEqual(audit.after, { submitApprovalRequired: false });
});

// ---------------------------------------------------------------------------
// FX capture
// ---------------------------------------------------------------------------

const FX_LINE = {
  description: "Export services",
  quantity: "1",
  unitPrice: "1000",
  vatRate: "0.075",
};

test("createDraft persists a valid rate and refuses NGN or malformed rates", async () => {
  const { invoice } = await createDraft(
    {
      firmId: firmOn,
      supplierPartyId: clientOn,
      buyerPartyId: buyerParty,
      invoiceNumber: `FX-${SALT}-USD`,
      currency: "USD",
      fxRateToNgn: "1500.5",
      issueDate: "2026-07-01",
      lines: [FX_LINE],
    },
    makerId,
  );
  assert.equal(Number(invoice.fxRateToNgn), 1500.5, "the rate persists");

  const baseInput = {
    firmId: firmOn,
    supplierPartyId: clientOn,
    buyerPartyId: buyerParty,
    issueDate: "2026-07-01",
    lines: [FX_LINE],
  };
  // Explicit NGN + rate, and the currency DEFAULT (NGN) + rate.
  await assert.rejects(
    createDraft({ ...baseInput, invoiceNumber: `FX-${SALT}-NGN-EXPL`, currency: "NGN", fxRateToNgn: "1500" }),
    isDomainError("FX_RATE_INVALID", 400),
  );
  await assert.rejects(
    createDraft({ ...baseInput, invoiceNumber: `FX-${SALT}-NGN-DEF`, fxRateToNgn: "1500" }),
    isDomainError("FX_RATE_INVALID", 400),
  );
  // Malformed: grouping separators, >6 decimals, non-positive.
  for (const bad of ["1,500", "1.2345678", "0", "-2", "abc"]) {
    await assert.rejects(
      createDraft({
        ...baseInput,
        invoiceNumber: `FX-${SALT}-BAD`,
        currency: "USD",
        fxRateToNgn: bad,
      }),
      isDomainError("FX_RATE_INVALID", 400),
      `"${bad}" must be refused`,
    );
  }
});

test("update sets, validates and clears the rate", async () => {
  const { invoice } = await createDraft(
    {
      firmId: firmOn,
      supplierPartyId: clientOn,
      buyerPartyId: buyerParty,
      invoiceNumber: `FX-${SALT}-EUR`,
      currency: "EUR",
      issueDate: "2026-07-01",
      lines: [FX_LINE],
    },
    makerId,
  );
  assert.equal(invoice.fxRateToNgn, null, "no rate captured");

  const set = await updateInvoiceContent(invoice.id, { fxRateToNgn: "1712.25" }, makerId);
  assert.equal(Number(set.invoice.fxRateToNgn), 1712.25);
  await assert.rejects(
    updateInvoiceContent(invoice.id, { fxRateToNgn: "1.2345678" }, makerId),
    isDomainError("FX_RATE_INVALID", 400),
  );
  const cleared = await updateInvoiceContent(invoice.id, { fxRateToNgn: null }, makerId);
  assert.equal(cleared.invoice.fxRateToNgn, null, "null clears the rate");
});

test("the CSV export appends fxRateToNgn and ngnEquivalent", async () => {
  // The EUR draft above ends the previous test with NO rate (cleared) —
  // its ngnEquivalent must be an honest blank. Add an NGN control row.
  await createDraft(
    {
      firmId: firmOn,
      supplierPartyId: clientOn,
      buyerPartyId: buyerParty,
      invoiceNumber: `FX-${SALT}-LOCAL`,
      issueDate: "2026-07-01",
      lines: [FX_LINE],
    },
    makerId,
  );

  const base = await listen(appFor(makerOn, invoicesRouter));
  const res = await fetch(`${base}/invoices/export?q=FX-${SALT}`);
  assert.equal(res.status, 200);
  const rows = parseCsv((await res.text()).replace(/^﻿/, ""));
  const header = rows[0];
  for (const col of ["currency", "fxRateToNgn", "ngnEquivalent"]) {
    assert.ok(header.includes(col), `header carries ${col}`);
  }
  const idx = (name: string) => header.indexOf(name);
  const byNumber = new Map(rows.slice(1).map((r) => [r[idx("invoiceNumber")], r]));

  const usd = byNumber.get(`FX-${SALT}-USD`)!;
  assert.equal(usd[idx("currency")], "USD");
  assert.equal(Number(usd[idx("fxRateToNgn")]), 1500.5);
  // 1075.00 grand total x 1500.5 NGN per USD.
  assert.equal(usd[idx("ngnEquivalent")], "1613037.50");

  const local = byNumber.get(`FX-${SALT}-LOCAL`)!;
  assert.equal(local[idx("currency")], "NGN");
  assert.equal(local[idx("fxRateToNgn")], "");
  assert.equal(local[idx("ngnEquivalent")], "1075.00", "NGN is already naira");

  const eur = byNumber.get(`FX-${SALT}-EUR`)!;
  assert.equal(eur[idx("fxRateToNgn")], "");
  assert.equal(eur[idx("ngnEquivalent")], "", "no rate = unconvertible, never 1.0");
});
