import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  getDb,
  collectionAccountsTable,
  engagementsTable,
  firmPoliciesTable,
  firmsTable,
  invoicesTable,
  partiesTable,
} from "@workspace/db";
import { computeMonthEndClose } from "./month-end-close.ts";
import { appendAudit } from "../audit/audit.ts";
import { daysAgo, makeRunSalt } from "../../test-helpers/fixtures.ts";

// Month-end close assistant (round-19 idea #2). Pinned invariants:
//  - the checklist contains ZERO predicates of its own — each line is the
//    existing detector's answer, so a line can never disagree with the
//    card it summarizes (spot-checked here via the overdue detector);
//  - clear months read as clear: every item present with status "clear";
//  - the approvals line exists only when the maker-checker policy is ON
//    (the null-when-off rule — a policy the firm never adopted is noise);
//  - scope: another client's paper never leaks into the checklist.

const SALT = makeRunSalt();
const firmId = randomUUID();
const clientParty = randomUUID();
const cleanParty = randomUUID();
const buyer = randomUUID();

before(async () => {
  const db = getDb();
  await db.insert(firmsTable).values({ id: firmId, name: `MC Firm ${SALT}` });
  await db.insert(partiesTable).values([
    { id: clientParty, type: "client_business", legalName: `MC Client ${SALT}` },
    { id: cleanParty, type: "client_business", legalName: `MC Clean ${SALT}` },
    { id: buyer, type: "buyer", legalName: `MC Buyer ${SALT}` },
  ]);
  await db.insert(engagementsTable).values([
    { firmId, clientPartyId: clientParty, type: "retainer", status: "open", title: `mc A ${SALT}` },
    { firmId, clientPartyId: cleanParty, type: "retainer", status: "open", title: `mc B ${SALT}` },
  ]);
  // One overdue draft — exactly one item should need attention.
  await db.insert(invoicesTable).values({
    firmId,
    supplierPartyId: clientParty,
    buyerPartyId: buyer,
    invoiceNumber: `MC-OD-${SALT}`,
    issueDate: daysAgo(20),
    status: "draft",
    grandTotal: "50000.00",
    subtotal: "46511.63",
    vatTotal: "3488.37",
  });
});

test("one overdue draft turns exactly one line to attention", async () => {
  const close = await computeMonthEndClose(firmId, clientParty);
  assert.match(close.asOf, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(close.note, /Advisory only/);

  const keys = close.items.map((i) => i.key);
  assert.deepEqual(keys, [
    "overdue_submissions",
    "unbilled_income",
    "unmatched_credits",
    "missing_bills",
    "double_payments",
    "unmatched_collections",
    "open_obligations",
  ]);
  assert.ok(
    !keys.includes("pending_approvals"),
    "approval policy off — the line is omitted, not zero",
  );

  const overdue = close.items.find((i) => i.key === "overdue_submissions");
  assert.ok(overdue);
  assert.equal(overdue.status, "attention");
  assert.equal(overdue.count, 1);
  assert.match(overdue.detail, /s\.104/);
  assert.equal(close.attentionCount, 1);
  for (const item of close.items) {
    if (item.key === "overdue_submissions") continue;
    assert.equal(item.status, "clear", `${item.key} is clear`);
    assert.equal(item.count, 0);
  }
});

test("a clean client reads all clear, and scope holds", async () => {
  const close = await computeMonthEndClose(firmId, cleanParty);
  assert.equal(close.attentionCount, 0, "the sibling's overdue paper stays out");
  for (const item of close.items) assert.equal(item.status, "clear");
});

test("an unmatched collection payment turns the collections line (honest count, not the capped array)", async () => {
  // Seed the pointer-only trace the inbound webhook leaves: a live
  // collection account plus one collections.unmatched audit event — the
  // review-confirmed M3 path (the close must count events directly, never
  // sum the report's capped per-account array).
  const [account] = await getDb()
    .insert(collectionAccountsTable)
    .values({
      firmId,
      clientPartyId: clientParty,
      provider: "test-provider",
      accountReference: `MC-ACC-${SALT}`,
      label: `MC test ${SALT}`,
    })
    .returning();
  await appendAudit({
    actorId: null,
    firmId,
    action: "collections.unmatched",
    entityType: "collection_account",
    entityId: account.id,
    after: { reason: "test seed" },
  });

  const close = await computeMonthEndClose(firmId, clientParty);
  const line = close.items.find((i) => i.key === "unmatched_collections");
  assert.ok(line);
  assert.equal(line.status, "attention");
  assert.equal(line.count, 1);
  // The sibling client's checklist stays clear — account scoping holds.
  const sibling = await computeMonthEndClose(firmId, cleanParty);
  const siblingLine = sibling.items.find(
    (i) => i.key === "unmatched_collections",
  );
  assert.ok(siblingLine);
  assert.equal(siblingLine.count, 0);
});

test("turning the maker-checker policy on adds the approvals line", async () => {
  await getDb()
    .insert(firmPoliciesTable)
    .values({ firmId, submitApprovalRequired: true });
  try {
    const close = await computeMonthEndClose(firmId, clientParty);
    const approvals = close.items.find((i) => i.key === "pending_approvals");
    assert.ok(approvals, "policy on — the line exists");
    // The overdue draft is receivable paper awaiting approval under the
    // policy, so the line agrees with the pendingApprovals detector.
    assert.equal(approvals.count, 1);
    assert.equal(approvals.status, "attention");
  } finally {
    await getDb()
      .delete(firmPoliciesTable)
      .where(eq(firmPoliciesTable.firmId, firmId));
  }
});
