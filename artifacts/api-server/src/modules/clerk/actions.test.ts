import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import {
  getDb,
  auditEventsTable,
  engagementsTable,
  featureFlagsTable,
  firmsTable,
  invoicesTable,
  partiesTable,
  submissionAttemptsTable,
  usersTable,
} from "@workspace/db";
import { recordConsent } from "../consent/consent.ts";
import { createDraft } from "../invoice/service.ts";
import { setFirmOverride } from "../flags/flags.ts";
import type { Principal } from "../auth/rbac.ts";
import {
  ACTIONS_FLAG_KEY,
  MAX_ACTION_TARGETS,
  MAX_CHASER_TARGETS,
  executeAction,
  listActionDecisions,
  listActionProposals,
} from "./actions.ts";
import { CLIENT_SAFE_DATA_INTENTS, DATA_INTENTS } from "./data-intents/index.ts";
import { executeActionBodyInvoiceIdsMax } from "@workspace/api-zod";
import { isDomainError } from "../../test-helpers/assertions.ts";
import { daysAgo, makeRunSalt } from "../../test-helpers/fixtures.ts";

// Proposed actions (round 21). Pinned invariants:
//  - fail-closed: while the clerk_actions flag is dark, proposals answer
//    EMPTY and execution refuses 503 — both ends, independently;
//  - proposals are live: only currently-overdue receivable drafts appear,
//    oldest first, with an honest targetCount;
//  - execution re-checks EVERY target at decision time (already-submitted,
//    fresh, or foreign ids are skipped, never re-processed) and rides the
//    ordinary per-invoice path (consent gate, validation, submission);
//  - the decision row is a durable, honest tally of what happened;
//  - firm walls hold on both surfaces.
// Fixtures are salted — submitted invoices persist in the shared DB.

const SALT = makeRunSalt();

const firmId = randomUUID();
const foreignFirmId = randomUUID();
const userId = randomUUID();
const supplier = randomUUID(); // complete + consented
const supplierNoConsent = randomUUID(); // complete, NO consent
const buyer = randomUUID(); // complete
const buyerNoTin = randomUUID(); // incomplete: fails canonical validation

const LINE = {
  description: "Goods",
  quantity: "1",
  unitPrice: "1000",
  vatRate: "0.075",
};

// executeAction's principal is the DRAFTING path's scope handle
// (draftPaymentChaser asserts tenant + party scope with it); the submit
// kinds derive nothing from it beyond what firmId/clientPartyId carry.
const firmPrincipal: Principal = {
  userId,
  role: "firm_admin",
  firmId,
  clientPartyId: null,
  buyerPartyId: null,
};
const foreignPrincipal: Principal = { ...firmPrincipal, firmId: foreignFirmId };

let n = 0;
function draftFor(
  buyerPartyId: string,
  issueDate: string,
  supplierPartyId = supplier,
): Promise<{ invoice: { id: string; invoiceNumber: string } }> {
  n += 1;
  return createDraft(
    {
      firmId,
      supplierPartyId,
      buyerPartyId,
      invoiceNumber: `ACT-${SALT}-${n}`,
      issueDate,
      dueDate: null,
      lines: [LINE],
    },
    userId,
  );
}

// Seeded in before(): oldest → newest so ordering is observable.
let overdueA: string; // 30 days old — well past the 7-day window
let overdueBad: string; // 25 days old, incomplete buyer — validation fails
let overdueB: string; // 20 days old
let fresh: string; // today — inside the window, never proposed

before(async () => {
  const db = getDb();
  // The flag row exactly as boot seeding ships it: DARK. Tests opt firms in
  // via per-firm overrides only, so the platform default is never touched.
  await db
    .insert(featureFlagsTable)
    .values({
      key: ACTIONS_FLAG_KEY,
      enabled: false,
      releaseTag: "R3",
      description: "Clerk proposed actions (test seed)",
    })
    .onConflictDoNothing({ target: featureFlagsTable.key });
  await db
    .insert(usersTable)
    .values({ id: userId, email: `actions-${SALT}@test.local` })
    .onConflictDoNothing();
  await db.insert(firmsTable).values([
    { id: firmId, name: `Actions Firm ${SALT}` },
    { id: foreignFirmId, name: `Actions Foreign ${SALT}` },
  ]);
  await db.insert(partiesTable).values([
    {
      id: supplier,
      type: "client_business",
      legalName: `Actions Supplier ${SALT}`,
      tin: "10000000-0001",
      street: "1 Marina Rd",
      city: "Lagos",
    },
    {
      id: supplierNoConsent,
      type: "client_business",
      legalName: `Actions Unconsented ${SALT}`,
      tin: "10000000-0002",
      street: "2 Marina Rd",
      city: "Lagos",
    },
    {
      id: buyer,
      type: "buyer",
      legalName: `Actions Buyer ${SALT}`,
      tin: "20000000-0001",
      street: "3 Broad St",
      city: "Lagos",
    },
    {
      // No TIN/street/city: any invoice naming this buyer fails canonical
      // validation — the deterministic "invalid" fixture.
      id: buyerNoTin,
      type: "buyer",
      legalName: `Actions Incomplete Buyer ${SALT}`,
    },
  ]);
  await db.insert(engagementsTable).values([
    { firmId, clientPartyId: supplier, type: "readiness_assessment", title: "act A" },
    { firmId, clientPartyId: supplierNoConsent, type: "readiness_assessment", title: "act B" },
  ]);
  await recordConsent({
    partyId: supplier,
    layer: 1,
    action: "grant",
    scope: "compliance",
    basis: "contract",
    channel: "test",
    actorId: userId,
  });

  overdueA = (await draftFor(buyer, daysAgo(30))).invoice.id;
  overdueBad = (await draftFor(buyerNoTin, daysAgo(25))).invoice.id;
  overdueB = (await draftFor(buyer, daysAgo(20))).invoice.id;
  fresh = (await draftFor(buyer, daysAgo(0))).invoice.id;
});

test("dark flag: proposals answer empty and execution refuses — both ends", async () => {
  const proposals = await listActionProposals(firmId, supplier);
  assert.deepEqual(proposals.actions, []);
  assert.ok(proposals.note.length > 0, "the note still explains the surface");
  await assert.rejects(
    executeAction(
      firmId,
      supplier,
      userId,
      "submit_overdue",
      [overdueA],
      firmPrincipal,
    ),
    isDomainError("ACTIONS_DISABLED", 503),
  );
});

test("proposals are live: overdue drafts only, oldest first, honest count", async () => {
  // Opt the firm in via a per-firm override — the pilot-rollout shape (the
  // platform default stays dark).
  await setFirmOverride(ACTIONS_FLAG_KEY, firmId, true);

  const { actions } = await listActionProposals(firmId, supplier);
  assert.equal(actions.length, 1);
  const [action] = actions;
  assert.equal(action.kind, "submit_overdue");
  assert.equal(action.targetCount, 3);
  assert.equal(action.truncated, false);
  assert.deepEqual(
    action.targets.map((t) => t.invoiceId),
    [overdueA, overdueBad, overdueB],
    "oldest first, the fresh draft absent",
  );
  assert.ok(action.targets.every((t) => t.daysOverdue > 0));
  assert.equal(action.evidence.overdueCount, 3);
  assert.match(action.why, /7-day statutory submission window/);
  assert.match(action.why, /estimate not advice/);
});

test("execution re-checks every target and records an honest decision", async () => {
  const missing = randomUUID();
  const { decision } = await executeAction(
    firmId,
    supplier,
    userId,
    "submit_overdue",
    [overdueA, overdueBad, fresh, missing],
    firmPrincipal,
  );

  const outcomes = new Map(decision.targets.map((t) => [t.invoiceId, t]));
  assert.equal(outcomes.get(overdueA)?.outcome, "submitted");
  assert.equal(outcomes.get(overdueBad)?.outcome, "invalid");
  assert.equal(outcomes.get(fresh)?.outcome, "skipped_not_eligible");
  assert.equal(outcomes.get(missing)?.outcome, "skipped_not_eligible");
  assert.match(
    outcomes.get(missing)?.error ?? "",
    /Not found/,
    "an id outside the client's records is named as such",
  );

  assert.equal(decision.requestedCount, 4);
  assert.equal(decision.executedCount, 1);
  assert.equal(decision.skippedCount, 2);
  assert.equal(decision.failedCount, 1);
  assert.equal(decision.decidedBy, userId);

  // Evidence is the PRE-execution picture (verification-pass F4): all three
  // overdue invoices existed when the human approved, even though one was
  // just submitted — a reader must never see the residual and conclude the
  // approval was baseless.
  assert.equal(decision.evidence.overdueCountAtDecision, 3);
  assert.notEqual(decision.evidence.exposureFloorNgn, "0");

  // The submission is REAL — the ordinary path ran, the draft flipped.
  const db = getDb();
  const statusOf = async (id: string) =>
    (
      await db
        .select({ status: invoicesTable.status })
        .from(invoicesTable)
        .where(eq(invoicesTable.id, id))
    )[0]!.status;
  assert.equal(await statusOf(overdueA), "submitted");
  assert.equal(
    await statusOf(overdueBad),
    "draft",
    "an invalid draft is reported, not touched",
  );

  // The decision surfaces on the list, and the audit trail is pointer-only.
  const decisions = await listActionDecisions(firmId, supplier);
  assert.equal(decisions[0]?.id, decision.id);
  const [audit] = await db
    .select()
    .from(auditEventsTable)
    .where(eq(auditEventsTable.action, "clerk.action.executed"))
    .orderBy(desc(auditEventsTable.seq))
    .limit(1);
  assert.ok(audit);
  assert.equal(audit.entityId, decision.id);

  // Approving the same batch again re-processes NOTHING.
  const again = await executeAction(
    firmId,
    supplier,
    userId,
    "submit_overdue",
    [overdueA],
    firmPrincipal,
  );
  assert.equal(again.decision.executedCount, 0);
  assert.equal(again.decision.skippedCount, 1);
  assert.match(
    again.decision.targets[0].error ?? "",
    /No longer matches/,
    "an already-submitted target is skipped, never double-processed",
  );
});

test("the module bound and the contract bound are the same number", () => {
  assert.equal(MAX_ACTION_TARGETS, executeActionBodyInvoiceIdsMax);
});

test("a repeated id is processed once and counted once", async () => {
  const dup = (await draftFor(buyer, daysAgo(12))).invoice.id;
  const { decision } = await executeAction(
    firmId,
    supplier,
    userId,
    "submit_overdue",
    [dup, dup],
    firmPrincipal,
  );
  assert.equal(decision.requestedCount, 1);
  assert.equal(decision.targets.length, 1);
  assert.equal(decision.targets[0].outcome, "submitted");
  assert.equal(decision.executedCount, 1);
});

test("the catalogue is closed and the batch is bounded", async () => {
  await assert.rejects(
    executeAction(
      firmId,
      supplier,
      userId,
      "send_everything",
      [randomUUID()],
      firmPrincipal,
    ),
    isDomainError("UNKNOWN_ACTION", 400),
  );
  await assert.rejects(
    executeAction(firmId, supplier, userId, "submit_overdue", [], firmPrincipal),
    isDomainError("BAD_TARGETS", 400),
  );
  await assert.rejects(
    executeAction(
      firmId,
      supplier,
      userId,
      "submit_overdue",
      Array.from({ length: MAX_ACTION_TARGETS + 1 }, () => randomUUID()),
      firmPrincipal,
    ),
    isDomainError("BAD_TARGETS", 400),
  );
  // The chaser batch is a batch of MODEL calls — its own, much lower cap.
  await assert.rejects(
    executeAction(
      firmId,
      supplier,
      userId,
      "draft_chasers",
      Array.from({ length: MAX_CHASER_TARGETS + 1 }, () => randomUUID()),
      firmPrincipal,
    ),
    isDomainError("BAD_TARGETS", 400),
  );
});

test("a client without layer-1 consent is refused up front", async () => {
  await draftFor(buyer, daysAgo(15), supplierNoConsent);
  await assert.rejects(
    executeAction(
      firmId,
      supplierNoConsent,
      userId,
      "submit_overdue",
      [randomUUID()],
      firmPrincipal,
    ),
    isDomainError("CONSENT_REQUIRED", 403),
  );
});

test("retry_failed proposes rail-rejected paper and retries it through the ordinary path", async () => {
  const failedInv = randomUUID();
  const db = getDb();
  await db.insert(invoicesTable).values({
    id: failedInv,
    firmId,
    supplierPartyId: supplier,
    buyerPartyId: buyer,
    invoiceNumber: `ACT-${SALT}-F1`,
    issueDate: daysAgo(12),
    status: "failed",
    grandTotal: "50000.00",
    subtotal: "46511.63",
    vatTotal: "3488.37",
  });
  await db.insert(submissionAttemptsTable).values({
    invoiceId: failedInv,
    rail: "rail_primary",
    attemptNo: 1,
    idempotencyKey: `act-${SALT}-f1`,
    status: "rejected",
    errorCode: "MBS_INVALID_TIN",
  });

  const { actions } = await listActionProposals(firmId, supplier);
  const retry = actions.find((a) => a.kind === "retry_failed");
  assert.ok(retry, "the failed paper is proposed for retry");
  assert.equal(retry.targetCount, 1);
  assert.equal(retry.targets[0].invoiceId, failedInv);
  assert.equal(
    retry.targets[0].note,
    "last failure: MBS_INVALID_TIN",
    "the last rail error rides the target so the human can judge the fix",
  );
  assert.match(retry.why, /fail again/);

  // Approval retries THROUGH submitInvoice (failed → submitted is the
  // lifecycle's own fix-and-retry edge); a non-failed id skips.
  const { decision, drafts } = await executeAction(
    firmId,
    supplier,
    userId,
    "retry_failed",
    [failedInv, fresh],
    firmPrincipal,
  );
  assert.equal(drafts, null, "a submit kind carries no drafts");
  const byId = new Map(decision.targets.map((t) => [t.invoiceId, t]));
  assert.equal(byId.get(failedInv)?.outcome, "submitted");
  assert.equal(byId.get(fresh)?.outcome, "skipped_not_eligible");
  assert.equal(decision.evidence.failedCountAtDecision, 1);
  const [row] = await db
    .select({ status: invoicesTable.status })
    .from(invoicesTable)
    .where(eq(invoicesTable.id, failedInv));
  assert.equal(row.status, "submitted", "the retry is a REAL resubmission");
});

test("draft_chasers drafts staged reminders — the platform sends nothing", async () => {
  const chaseInv = randomUUID();
  const db = getDb();
  await db.insert(invoicesTable).values({
    id: chaseInv,
    firmId,
    supplierPartyId: supplier,
    buyerPartyId: buyer,
    invoiceNumber: `ACT-${SALT}-C1`,
    issueDate: daysAgo(45),
    dueDate: daysAgo(30),
    status: "submitted",
    grandTotal: "80000.00",
    subtotal: "74418.60",
    vatTotal: "5581.40",
  });

  const { actions } = await listActionProposals(firmId, supplier);
  const chase = actions.find((a) => a.kind === "draft_chasers");
  assert.ok(chase, "the late receivable is proposed for a reminder");
  assert.match(chase.why, /platform sends nothing/);
  const target = chase.targets.find((t) => t.invoiceId === chaseInv);
  assert.ok(target, "the chase-worthy invoice is a target");
  assert.match(target.note ?? "", /Actions Buyer/);

  const { decision, drafts } = await executeAction(
    firmId,
    supplier,
    userId,
    "draft_chasers",
    [chaseInv, fresh],
    firmPrincipal,
  );
  const byId = new Map(decision.targets.map((t) => [t.invoiceId, t]));
  assert.equal(byId.get(chaseInv)?.outcome, "drafted");
  assert.equal(byId.get(fresh)?.outcome, "skipped_not_eligible");
  assert.equal(decision.executedCount, 1);
  assert.ok(drafts && drafts.length === 1, "the drafted text rides the response");
  assert.equal(
    drafts[0].source,
    "template",
    "no gateway in tests — the deterministic ladder answers",
  );
  assert.match(drafts[0].body, new RegExp(`ACT-${SALT}-C1`));
  // Drafting changed NOTHING on the invoice — no lifecycle event, no
  // chase-log row (the log records what the client actually sent).
  const [row] = await db
    .select({ status: invoicesTable.status })
    .from(invoicesTable)
    .where(eq(invoicesTable.id, chaseInv));
  assert.equal(row.status, "submitted");
  // The round's headline claim, PINNED: neither the decision row nor the
  // batch audit carries the drafted subject/body — the text rides the
  // response only.
  const decisionJson = JSON.stringify(decision);
  assert.ok(!decisionJson.includes(drafts[0].subject));
  assert.ok(!decisionJson.includes(drafts[0].body.slice(0, 40)));
  const [audit] = await db
    .select()
    .from(auditEventsTable)
    .where(eq(auditEventsTable.action, "clerk.action.executed"))
    .orderBy(desc(auditEventsTable.seq))
    .limit(1);
  assert.ok(audit);
  assert.ok(!JSON.stringify(audit.after).includes(drafts[0].subject));
});

test("the data.proposed_actions intent points at the approval surface", async () => {
  const intent = DATA_INTENTS.find((i) => i.key === "data.proposed_actions");
  assert.ok(intent, "the intent is registered");
  assert.ok(
    CLIENT_SAFE_DATA_INTENTS.some((i) => i.key === "data.proposed_actions"),
    "client askers may see their own pending batches",
  );
  const named = await intent.run(firmId, { clientPartyId: supplier });
  assert.match(named.text, /waiting for approval/);
  assert.match(named.text, /Nothing runs until a person approves/);
  const unnamed = await intent.run(firmId, {});
  assert.match(
    unnamed.text,
    /name the client/,
    "a firm asker without a client pin is asked to name one",
  );
});

// Module-level walls only: the execute ROUTE additionally refuses a party
// the principal cannot reach at all (assertPartyAccess, bulk-submit
// parity), so a real cross-firm caller never gets this far — these probes
// pin the data-layer behaviour underneath that wall.
test("firm walls hold on both surfaces", async () => {
  await setFirmOverride(ACTIONS_FLAG_KEY, foreignFirmId, true);
  // The foreign firm sees no proposals for a client it does not hold…
  const proposals = await listActionProposals(foreignFirmId, supplier);
  assert.deepEqual(proposals.actions, []);
  // …and executing against our client refuses at the CONSENT gate: every
  // stage runs as meridian_app under the CALLER's firm GUC (round 22's
  // per-stage contexts), so the engagement-scoped consent policy (0013)
  // hides the foreign client's grant — the refusal is byte-identical to an
  // unconsented own client's, never a consent oracle, and no decision row
  // is written. (The route's assertPartyAccess refuses even earlier.)
  await assert.rejects(
    executeAction(
      foreignFirmId,
      supplier,
      userId,
      "submit_overdue",
      [overdueB],
      foreignPrincipal,
    ),
    isDomainError("CONSENT_REQUIRED", 403),
  );
  const [row] = await getDb()
    .select({ status: invoicesTable.status })
    .from(invoicesTable)
    .where(eq(invoicesTable.id, overdueB));
  assert.equal(row.status, "draft", "the foreign approval changed nothing");
  // The CHASER kind carries no consent gate, so its wall is the candidates
  // query alone (review L1): a foreign chaser batch drafts nothing and
  // leaks nothing — every target skips as not-found, and no draft is
  // produced for another firm's paper.
  const foreignChase = await executeAction(
    foreignFirmId,
    supplier,
    userId,
    "draft_chasers",
    [overdueB],
    foreignPrincipal,
  );
  assert.equal(foreignChase.decision.executedCount, 0);
  assert.equal(foreignChase.decision.skippedCount, 1);
  assert.deepEqual(foreignChase.drafts, []);
  assert.match(
    foreignChase.decision.targets[0].error ?? "",
    /Not found/,
    "the wall answers non-disclosure, not the sibling's invoice number",
  );
  // Nothing foreign ever lands on our firm's decision list.
  const ours = await listActionDecisions(firmId, supplier);
  assert.ok(ours.every((d) => d.firmId === firmId));
});
