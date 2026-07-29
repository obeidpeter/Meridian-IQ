import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  getDb,
  engagementsTable,
  firmsTable,
  invoicesTable,
  partiesTable,
} from "@workspace/db";
import {
  awaitingApproval,
  pendingApprovals,
  recordApproval,
  revokeLiveApprovals,
  updateFirmPolicies,
} from "./approvals.ts";
import { computeStatusLight } from "../clerk/status-light.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Awaiting-approval visibility (round-17 idea #2). Pinned here:
//  - policy OFF answers null / false — "0 waiting" and "no policy" must
//    never read the same;
//  - policy ON counts pre-submission receivable paper with no LIVE approval
//    (a bill and a submitted invoice never count), oldest first, with the
//    per-client filter for the forced Ask pin;
//  - a recorded approval clears the wait; revoking it restores the wait —
//    approvals are evidence, and only LIVE evidence unblocks;
//  - the status light's amber answers "why can't I submit?" when the flag
//    is threaded in.

const SALT = makeRunSalt();
const firmId = randomUUID();
const clientParty = randomUUID();
const siblingParty = randomUUID();
const buyerParty = randomUUID();
const vendorParty = randomUUID();
const actorA = randomUUID();
const actorB = randomUUID();

let draftOldId: string;
let billId: string;

async function seedInvoice(input: {
  supplierPartyId: string;
  buyerPartyId: string;
  invoiceNumber: string;
  status: string;
  createdAt?: Date;
}): Promise<string> {
  const id = randomUUID();
  await getDb().insert(invoicesTable).values({
    id,
    firmId,
    supplierPartyId: input.supplierPartyId,
    buyerPartyId: input.buyerPartyId,
    invoiceNumber: input.invoiceNumber,
    status: input.status as never,
    issueDate: "2026-07-01",
    grandTotal: "100.00",
    subtotal: "100.00",
    vatTotal: "0.00",
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
  });
  return id;
}

before(async () => {
  const db = getDb();
  await db.insert(firmsTable).values({ id: firmId, name: `Appr Firm ${SALT}` });
  await db.insert(partiesTable).values([
    { id: clientParty, type: "client_business", legalName: `Appr Client ${SALT}` },
    { id: siblingParty, type: "client_business", legalName: `Appr Sibling ${SALT}` },
    { id: buyerParty, type: "buyer", legalName: `Appr Buyer ${SALT}` },
    { id: vendorParty, type: "buyer", legalName: `Appr Vendor ${SALT}` },
  ]);
  await db.insert(engagementsTable).values([
    { firmId, clientPartyId: clientParty, type: "retainer", title: `ap A ${SALT}` },
    { firmId, clientPartyId: siblingParty, type: "retainer", title: `ap B ${SALT}` },
  ]);
  // Three pre-submission receivables for the client (one old), one for the
  // sibling; a submitted invoice and a captured BILL that must never count.
  draftOldId = await seedInvoice({
    supplierPartyId: clientParty,
    buyerPartyId: buyerParty,
    invoiceNumber: `AP-OLD-${SALT}`,
    status: "draft",
    createdAt: new Date(Date.now() - 9 * 86_400_000),
  });
  await seedInvoice({
    supplierPartyId: clientParty,
    buyerPartyId: buyerParty,
    invoiceNumber: `AP-VAL-${SALT}`,
    status: "validated",
  });
  await seedInvoice({
    supplierPartyId: clientParty,
    buyerPartyId: buyerParty,
    invoiceNumber: `AP-FAIL-${SALT}`,
    status: "failed",
  });
  await seedInvoice({
    supplierPartyId: siblingParty,
    buyerPartyId: buyerParty,
    invoiceNumber: `AP-SIB-${SALT}`,
    status: "draft",
  });
  await seedInvoice({
    supplierPartyId: clientParty,
    buyerPartyId: buyerParty,
    invoiceNumber: `AP-SUB-${SALT}`,
    status: "submitted",
  });
  // The bill: the engaged client is the BUYER — draft forever, never waiting.
  billId = await seedInvoice({
    supplierPartyId: vendorParty,
    buyerPartyId: clientParty,
    invoiceNumber: `AP-BILL-${SALT}`,
    status: "draft",
  });
});

const invoiceRef = (id: string, status = "draft", kind = "invoice") => ({
  id,
  firmId,
  supplierPartyId: clientParty,
  buyerPartyId: buyerParty,
  status,
  kind,
});

test("policy off answers null / false — never a zero", async () => {
  assert.equal(await pendingApprovals(firmId), null);
  assert.equal(await awaitingApproval(invoiceRef(draftOldId)), false);
});

test("policy on counts pre-submission receivables without a live approval", async () => {
  await updateFirmPolicies(firmId, { submitApprovalRequired: true }, actorA);
  const all = await pendingApprovals(firmId);
  assert.ok(all);
  assert.equal(all.count, 4, "bill and submitted paper never count");
  assert.equal(all.invoices[0].invoiceNumber, `AP-OLD-${SALT}`, "oldest first");
  assert.equal(all.oldestDays, 9);
  const mine = await pendingApprovals(firmId, clientParty);
  assert.ok(mine);
  assert.equal(mine.count, 3, "the sibling's draft is outside the client pin");
  assert.equal(
    await awaitingApproval(invoiceRef(draftOldId)),
    true,
  );
});

test("a bill and a credit note are never 'awaiting approval'", async () => {
  // Round-17 review H1: the status light must not tell non-submittable
  // paper it is blocked on an approval — that block does not exist and the
  // recommended action would 409.
  assert.equal(
    await awaitingApproval({
      id: billId,
      firmId,
      supplierPartyId: vendorParty,
      buyerPartyId: clientParty,
      status: "draft",
      kind: "invoice",
    }),
    false,
    "a captured bill never waits — it never submits",
  );
  assert.equal(
    await awaitingApproval(invoiceRef(draftOldId, "draft", "credit_note")),
    false,
    "a credit note never waits",
  );
});

test("a live approval clears the wait; revoking it restores the wait", async () => {
  await recordApproval(
    {
      id: draftOldId,
      firmId,
      supplierPartyId: clientParty,
      buyerPartyId: buyerParty,
      status: "draft",
    },
    actorB,
  );
  assert.equal(
    await awaitingApproval(invoiceRef(draftOldId)),
    false,
  );
  const after = await pendingApprovals(firmId);
  assert.equal(after?.count, 3);
  await revokeLiveApprovals(draftOldId);
  assert.equal(
    await awaitingApproval(invoiceRef(draftOldId)),
    true,
    "only LIVE evidence unblocks",
  );
  assert.equal((await pendingApprovals(firmId))?.count, 4);
});

test("the status light explains the approval wait", () => {
  const light = computeStatusLight({
    invoice: { status: "draft", dueDate: null },
    attempts: [],
    confirmations: [],
    stamp: null,
    awaitingApproval: true,
  });
  assert.equal(light.light, "amber");
  assert.ok(
    light.reasons.some((r) => /colleague's approval/.test(r)),
    "the reason names the block",
  );
  assert.match(light.recommendedAction, /approve/i);
  // Failed paper stays red but warns that resubmission ALSO needs the
  // approval — the fix-first action must not walk into a surprise 409.
  const failed = computeStatusLight({
    invoice: { status: "failed", dueDate: null },
    attempts: [],
    confirmations: [],
    stamp: null,
    awaitingApproval: true,
  });
  assert.equal(failed.light, "red");
  assert.ok(failed.reasons.some((r) => /approval is also required/.test(r)));
});
