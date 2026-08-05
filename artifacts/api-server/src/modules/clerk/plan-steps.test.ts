import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, like } from "drizzle-orm";
import {
  getDb,
  bankStatementLinesTable,
  bankStatementsTable,
  clerkPlanRunsTable,
  engagementsTable,
  featureFlagsTable,
  firmsTable,
  invoicesTable,
  invoiceLinesTable,
  matchProposalsTable,
  membershipsTable,
  partiesTable,
  usersTable,
} from "@workspace/db";
import { createDraft } from "../invoice/service.ts";
import { setFirmOverride } from "../flags/flags.ts";
import type { Principal } from "../auth/rbac.ts";
import {
  ACTIONS_FLAG_KEY,
  executeAction,
  proposalForKind,
} from "./actions.ts";
import {
  AUTO_RECONCILE_FLAG_KEY,
  MACHINE_DRAFT_PREFIX,
  assembleDraftRecurring,
  assembleReconcileMatches,
  executeDraftRecurring,
  stepTargetKey,
} from "./plan-steps.ts";
import {
  MAX_PLAN_STEPS,
  PLAN_TEMPLATES,
  createPlanRunFromTemplate,
  processPlanRun,
} from "./plan-runs.ts";
import {
  restoreClerkFlag,
  saveAndEnableClerkFlag,
} from "./test-support.ts";
import { isDomainError } from "../../test-helpers/assertions.ts";
import { daysAgo, makeRunSalt } from "../../test-helpers/fixtures.ts";
import {
  clientPrincipal,
  firmPrincipal as makeFirmPrincipal,
} from "../../test-helpers/principals.ts";
import { grantComplianceConsent } from "../../test-helpers/seeders.ts";
import { src } from "../../test-helpers/source-pins.ts";
import { lagosDateString } from "../../lib/lagos-time.ts";

// Deterministic plan steps (round 34, Close with Clerk Phase 1). Pinned:
//  - assembly finds the unbilled monthly habit (and ONLY it), keyed by
//    (buyer, currency) pair;
//  - execution drafts ONLY approved pairs whose pattern still alerts —
//    approval is not a license to draft against a book that moved;
//  - the end-to-end template run raises the missing paper as DRAFTS with
//    the buyer's own newest lines, a placeholder number, no decision row,
//    and the draft ids as step evidence;
//  - the step is idempotent: the created draft closes the pattern, and an
//    OPEN machine draft blocks a second one even after the pattern would
//    re-alert (the anti-pile-up guard);
//  - THE WALL (round-34 review BLOCKER): a machine draft is never a
//    submit_overdue target — not in the proposal, not at execution — so
//    no recurring policy or whole-plan approval can push an unreviewed
//    placeholder invoice to the rails. A human renaming it clears the
//    wall; that is the review.

const SALT = makeRunSalt();

const firmId = randomUUID();
const userId = randomUUID();
const clientX = randomUUID();
const buyerP = randomUUID(); // billed monthly, unbilled this cycle
const buyerQ = randomUUID(); // one-off buyer — no pattern

const principal: Principal = makeFirmPrincipal(firmId, { userId });

async function loadRun(runId: string) {
  const [row] = await getDb()
    .select()
    .from(clerkPlanRunsTable)
    .where(eq(clerkPlanRunsTable.id, runId));
  return row;
}

async function driveToTerminal(runId: string): Promise<void> {
  for (let i = 0; i < 30; i++) {
    const [row] = await getDb()
      .select({ status: clerkPlanRunsTable.status })
      .from(clerkPlanRunsTable)
      .where(eq(clerkPlanRunsTable.id, runId));
    if (row && ["done", "halted", "failed"].includes(row.status)) return;
    await processPlanRun(runId);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function openMachineDrafts() {
  return getDb()
    .select()
    .from(invoicesTable)
    .where(
      and(
        eq(invoicesTable.firmId, firmId),
        eq(invoicesTable.supplierPartyId, clientX),
        eq(invoicesTable.status, "draft"),
        like(invoicesTable.invoiceNumber, `${MACHINE_DRAFT_PREFIX}%`),
      ),
    );
}

before(async () => {
  await saveAndEnableClerkFlag();
  const db = getDb();
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
    .values({ id: userId, email: `plan-steps-${SALT}@test.local` })
    .onConflictDoNothing();
  await db.insert(firmsTable).values({ id: firmId, name: `Steps Firm ${SALT}` });
  await setFirmOverride(ACTIONS_FLAG_KEY, firmId, true);
  await db.insert(membershipsTable).values({
    userId,
    firmId,
    role: "firm_admin",
  });
  await db.insert(partiesTable).values([
    {
      id: clientX,
      type: "client_business",
      legalName: `Steps Client ${SALT}`,
      tin: "51000000-0001",
      street: "1 Marina Rd",
      city: "Lagos",
    },
    {
      id: buyerP,
      type: "buyer",
      legalName: `Steps Retainer ${SALT}`,
      tin: "61000000-0001",
      street: "2 Broad St",
      city: "Lagos",
    },
    {
      id: buyerQ,
      type: "buyer",
      legalName: `Steps OneOff ${SALT}`,
      tin: "61000000-0002",
      street: "3 Broad St",
      city: "Lagos",
    },
  ]);
  await db.insert(engagementsTable).values({
    firmId,
    clientPartyId: clientX,
    type: "readiness_assessment",
    title: "px",
  });
  await grantComplianceConsent(clientX, userId);
  // The mined history: buyerP billed monthly (gap 30, span 60, equal
  // amounts), last invoice 40 days ago — squarely inside the alert window
  // (expected ~10 days ago, grace 5, max 45). buyerQ has one invoice — no
  // pattern. Every history row is STAMPED: mined (not cancelled/credited)
  // but invisible to submit_overdue, so the month-end template assembles
  // ONLY the draft_recurring step for this client.
  let n = 0;
  const history = async (buyerPartyId: string, issueDate: string) => {
    n += 1;
    const { invoice } = await createDraft(
      {
        firmId,
        supplierPartyId: clientX,
        buyerPartyId,
        invoiceNumber: `STEPS-${SALT}-${n}`,
        issueDate,
        dueDate: null,
        lines: [
          {
            description: "Monthly retainer",
            quantity: "1",
            unitPrice: "2000",
            vatRate: "0.075",
          },
        ],
      },
      userId,
    );
    await getDb()
      .update(invoicesTable)
      .set({ status: "stamped" })
      .where(eq(invoicesTable.id, invoice.id));
    return invoice.id;
  };
  await history(buyerP, daysAgo(100));
  await history(buyerP, daysAgo(70));
  await history(buyerP, daysAgo(40));
  await history(buyerQ, daysAgo(40));
});

after(async () => {
  await restoreClerkFlag();
});

test("the machine-draft prefix and the SQL submission wall stay in lockstep", () => {
  assert.equal(MACHINE_DRAFT_PREFIX, "DRAFT-");
  assert.ok(
    src("modules/clerk/actions.ts").includes(
      "i.invoice_number NOT LIKE 'DRAFT-%'",
    ),
    "overdueCond must exclude machine drafts — the round-34 BLOCKER wall",
  );
});

test("assembly finds the unbilled monthly habit and only it", async () => {
  assert.deepEqual(await assembleDraftRecurring(firmId, clientX), [
    stepTargetKey(buyerP, "NGN"),
  ]);
});

test("execution drafts only APPROVED pairs whose pattern still alerts", async () => {
  // buyerQ was approved but never had a pattern; buyerP has the pattern
  // but was NOT approved — nothing may be drafted either way.
  const outcome = await executeDraftRecurring(
    firmId,
    clientX,
    [stepTargetKey(buyerQ, "NGN")],
    userId,
    randomUUID(),
  );
  assert.deepEqual(outcome, { draftIds: [], executed: 0, skipped: 1, failed: 0 });
  assert.equal((await openMachineDrafts()).length, 0);
});

test("the template run raises the missing paper as drafts (end-to-end)", async () => {
  const run = await createPlanRunFromTemplate("month_end_close", clientX, principal);
  assert.equal(run.steps.length, 1, "only the draft step assembles");
  assert.equal(run.steps[0].kind, "draft_recurring");
  assert.deepEqual(run.steps[0].buyerTargets, [stepTargetKey(buyerP, "NGN")]);
  assert.deepEqual(run.steps[0].invoiceIds, []);

  await driveToTerminal(run.id);
  const done = await loadRun(run.id);
  assert.equal(done.status, "done");
  const step = done.steps[0];
  assert.equal(step.status, "executed");
  assert.equal(step.executedCount, 1);
  assert.equal(step.failedCount, 0);
  assert.equal(step.skippedCount, 0);
  assert.equal(step.decisionId, null, "no decision row for a deterministic step");
  assert.equal(step.draftIds?.length, 1, "the created draft is the evidence");

  const [draft] = await getDb()
    .select()
    .from(invoicesTable)
    .where(eq(invoicesTable.id, step.draftIds![0]));
  assert.equal(draft.status, "draft", "Clerk raises drafts, never files");
  assert.equal(draft.supplierPartyId, clientX);
  assert.equal(draft.buyerPartyId, buyerP);
  assert.ok(
    draft.invoiceNumber.startsWith(MACHINE_DRAFT_PREFIX),
    "a placeholder number the client replaces at review",
  );
  assert.equal(draft.issueDate, lagosDateString());
  assert.equal(Number(draft.grandTotal), 2150, "2000 + 7.5% VAT, never invented");
  const lines = await getDb()
    .select()
    .from(invoiceLinesTable)
    .where(eq(invoiceLinesTable.invoiceId, draft.id));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].description, "Monthly retainer");
});

test("an open machine draft blocks both re-drafting AND auto-submission (the recurring month-M+1 case)", async () => {
  // Fresh draft today: the pattern is closed, a second run is empty.
  await assert.rejects(
    createPlanRunFromTemplate("month_end_close", clientX, principal),
    isDomainError("NOTHING_TO_RUN"),
  );
  // Now AGE the machine draft past both windows — exactly what a recurring
  // policy sees next month if nobody reviewed it: the pattern would
  // re-alert (last paper 40+ days old) and the draft is past the statutory
  // submission window. The anti-pile-up guard must block a second draft
  // and the submission wall must keep submit_overdue empty — so the
  // template as a whole still answers the honest NOTHING_TO_RUN, and the
  // unreviewed placeholder never reaches the rails.
  const [machineDraft] = await openMachineDrafts();
  await getDb()
    .update(invoicesTable)
    .set({ issueDate: daysAgo(40) })
    .where(eq(invoicesTable.id, machineDraft.id));
  await assert.rejects(
    createPlanRunFromTemplate("month_end_close", clientX, principal),
    isDomainError("NOTHING_TO_RUN"),
  );
  assert.equal((await openMachineDrafts()).length, 1, "no draft pile-up");
});

test("the wall holds at both proposal and execution; an ordinary draft passes it", async () => {
  // Control: an ordinary-numbered overdue draft IS proposed and the aged
  // machine draft is NOT — same client, same predicate, one wall.
  const { invoice: ordinary } = await createDraft(
    {
      firmId,
      supplierPartyId: clientX,
      buyerPartyId: buyerQ,
      invoiceNumber: `STEPS-${SALT}-ORD`,
      issueDate: daysAgo(10),
      dueDate: null,
      lines: [
        { description: "Goods", quantity: "1", unitPrice: "500", vatRate: "0.075" },
      ],
    },
    userId,
  );
  const [machineDraft] = await openMachineDrafts();
  const proposal = await proposalForKind("submit_overdue", firmId, clientX);
  const proposedIds = (proposal?.targets ?? []).map((t) => t.invoiceId);
  assert.ok(proposedIds.includes(ordinary.id), "ordinary overdue drafts propose");
  assert.ok(
    !proposedIds.includes(machineDraft.id),
    "a machine draft is never proposed for submission",
  );
  // Execution-side: even an explicitly-passed machine draft id is refused
  // by the per-target re-validation, while the ordinary draft submits.
  const { decision } = await executeAction(
    firmId,
    clientX,
    userId,
    "submit_overdue",
    [machineDraft.id, ordinary.id],
    principal,
  );
  const byId = new Map(decision.targets.map((t) => [t.invoiceId, t.outcome]));
  assert.equal(byId.get(machineDraft.id), "skipped_not_eligible");
  assert.equal(byId.get(ordinary.id), "submitted");
});

// ---- reconcile_matches (round 35) ------------------------------------------
// Pinned: the step assembles NOTHING while EITHER flag is dark (its own
// clerk_auto_reconcile, layered on the base reconciliation flag); only
// best-per-line AND best-per-invoice receivable proposals at/above the
// autopilot threshold are frozen (a duplicated bank credit yields ONE
// acceptance, a bill proposal never rides); execution accepts through the
// ORDINARY acceptProposal path; a client_user approver and a POLICY-MINTED
// run both get the plan WITHOUT the step; an approver who loses the
// optional capability mid-run SKIPS the step instead of halting the plan.

const stmtId = randomUUID();
const lineA = randomUUID();
const lineB = randomUUID();
const lineC = randomUUID(); // duplicated credit: same invoice as lineA's best
let reconInvoice1: string;
let reconInvoice2: string;
let billInvoice: string; // clientX as BUYER — debit lane, never auto-accepted
let pStrong: string; // lineA → reconInvoice1, 0.95
let pSibling: string; // lineA → reconInvoice2, 0.92 (same line, weaker)
let pDupLine: string; // lineC → reconInvoice1, 0.91 (same INVOICE, second line)
let pBill: string; // lineB → billInvoice, 0.93 (bill orientation)
let pWeak: string; // lineB → reconInvoice2, 0.5 (below the bar)

async function seedReconcileWorld() {
  const db = getDb();
  for (const key of ["reconciliation", AUTO_RECONCILE_FLAG_KEY]) {
    await db
      .insert(featureFlagsTable)
      .values({ key, enabled: false, releaseTag: "R3", description: "seed" })
      .onConflictDoNothing({ target: featureFlagsTable.key });
  }
  // The base surface flag is lit (a firm that can SEE reconciliation);
  // the autopilot flag stays dark until the first assertion flips it.
  await setFirmOverride("reconciliation", firmId, true);
  const stamped = async (invoiceNumber: string, unitPrice: string) => {
    const { invoice } = await createDraft(
      {
        firmId,
        supplierPartyId: clientX,
        buyerPartyId: buyerQ,
        invoiceNumber,
        issueDate: daysAgo(15),
        dueDate: null,
        lines: [
          { description: "Services", quantity: "1", unitPrice, vatRate: "0.075" },
        ],
      },
      userId,
    );
    await db
      .update(invoicesTable)
      .set({ status: "stamped" })
      .where(eq(invoicesTable.id, invoice.id));
    return invoice.id;
  };
  reconInvoice1 = await stamped(`RECON-${SALT}-1`, "500");
  reconInvoice2 = await stamped(`RECON-${SALT}-2`, "800");
  // A BILL for clientX: the vendor as supplier, the client as buyer.
  const { invoice: bill } = await createDraft(
    {
      firmId,
      supplierPartyId: buyerQ,
      buyerPartyId: clientX,
      invoiceNumber: `RECON-${SALT}-BILL`,
      issueDate: daysAgo(15),
      dueDate: null,
      lines: [
        { description: "Vendor svc", quantity: "1", unitPrice: "500", vatRate: "0.075" },
      ],
    },
    userId,
  );
  billInvoice = bill.id;
  await db.insert(bankStatementsTable).values({
    id: stmtId,
    firmId,
    clientPartyId: clientX,
    formatKey: "gtb_csv",
    status: "committed",
    lineCount: 3,
    parsedCount: 3,
  });
  await db.insert(bankStatementLinesTable).values([
    {
      id: lineA,
      statementId: stmtId,
      lineNo: 1,
      valueDate: daysAgo(3),
      amount: "537.50",
      direction: "credit",
      narration: `TRF RECON ${SALT}`,
      parseStatus: "parsed",
      rawLine: "raw-a",
    },
    {
      id: lineB,
      statementId: stmtId,
      lineNo: 2,
      valueDate: daysAgo(3),
      amount: "537.50",
      direction: "credit",
      narration: "TRF ODD",
      parseStatus: "parsed",
      rawLine: "raw-b",
    },
    {
      id: lineC,
      statementId: stmtId,
      lineNo: 3,
      valueDate: daysAgo(2),
      amount: "537.50",
      direction: "credit",
      narration: `TRF RECON RETRY ${SALT}`,
      parseStatus: "parsed",
      rawLine: "raw-c",
    },
  ]);
  const proposal = async (statementLineId: string, invoiceId: string, confidence: string) => {
    const [row] = await db
      .insert(matchProposalsTable)
      .values({ firmId, statementLineId, invoiceId, confidence })
      .returning({ id: matchProposalsTable.id });
    return row.id;
  };
  pStrong = await proposal(lineA, reconInvoice1, "0.9500");
  pSibling = await proposal(lineA, reconInvoice2, "0.9200");
  pDupLine = await proposal(lineC, reconInvoice1, "0.9100");
  pBill = await proposal(lineB, billInvoice, "0.9300");
  pWeak = await proposal(lineB, reconInvoice2, "0.5000");
}

test("reconcile assembly: both flags gate it; best per line AND per invoice, receivables only", async () => {
  await seedReconcileWorld();
  assert.deepEqual(
    await assembleReconcileMatches(firmId, clientX),
    [],
    "a dark clerk_auto_reconcile assembles nothing",
  );
  await setFirmOverride(AUTO_RECONCILE_FLAG_KEY, firmId, true);
  await setFirmOverride("reconciliation", firmId, false);
  assert.deepEqual(
    await assembleReconcileMatches(firmId, clientX),
    [],
    "a rolled-back base reconciliation flag darkens the autopilot too",
  );
  await setFirmOverride("reconciliation", firmId, true);
  assert.deepEqual(
    await assembleReconcileMatches(firmId, clientX),
    [pStrong],
    "one target: the line-sibling dedups, the same-invoice second line dedups, the bill never rides, the weak one stays below the bar",
  );
});

test("a client_user approver gets the plan WITHOUT the staff-only reconcile step", async () => {
  const client = clientPrincipal(firmId, clientX, { userId });
  await assert.rejects(
    createPlanRunFromTemplate("month_end_close", clientX, client),
    isDomainError("NOTHING_TO_RUN"),
  );
});

test("a POLICY-MINTED run gets the plan WITHOUT the reconcile step (round-35 review M2)", async () => {
  // Same book, same firm principal — the ONLY difference is policyMinted:
  // a recurring grant was consented against the template as it stood at
  // grant time, so template growth must not expand it.
  await assert.rejects(
    createPlanRunFromTemplate("month_end_close", clientX, principal, {
      policyMinted: true,
    }),
    isDomainError("NOTHING_TO_RUN"),
  );
});

test("the reconcile step settles through the ordinary accept path (end-to-end)", async () => {
  const run = await createPlanRunFromTemplate("month_end_close", clientX, principal);
  assert.equal(run.steps.length, 1, "only the reconcile step assembles");
  assert.equal(run.steps[0].kind, "reconcile_matches");
  assert.deepEqual(run.steps[0].proposalTargets, [pStrong]);

  await driveToTerminal(run.id);
  const done = await loadRun(run.id);
  assert.equal(done.status, "done");
  const step = done.steps[0];
  assert.equal(step.status, "executed");
  assert.equal(step.executedCount, 1);
  assert.equal(step.failedCount, 0);
  assert.equal(step.decisionId, null);

  const [settled] = await getDb()
    .select({ status: invoicesTable.status })
    .from(invoicesTable)
    .where(eq(invoicesTable.id, reconInvoice1));
  assert.equal(settled.status, "settled", "the ordinary accept path ran");
  const statuses = new Map(
    (
      await getDb()
        .select({ id: matchProposalsTable.id, status: matchProposalsTable.status })
        .from(matchProposalsTable)
        .where(
          inArray(matchProposalsTable.id, [pStrong, pSibling, pDupLine, pBill, pWeak]),
        )
    ).map((r) => [r.id, r.status]),
  );
  assert.equal(statuses.get(pStrong), "accepted");
  assert.equal(statuses.get(pSibling), "superseded", "one line settles one invoice");
  assert.equal(
    statuses.get(pDupLine),
    "proposed",
    "the duplicated credit stays a HUMAN suggestion — never a second acceptance, never a failure",
  );
  assert.equal(statuses.get(pBill), "proposed", "the debit lane stays human");
  assert.equal(statuses.get(pWeak), "proposed", "below the bar stays human");
  // And nothing is left for a second run: the settled-invoice filter keeps
  // the leftover duplicate from re-assembling — the honest empty again.
  await assert.rejects(
    createPlanRunFromTemplate("month_end_close", clientX, principal),
    isDomainError("NOTHING_TO_RUN"),
  );
});

test("an approver who loses the OPTIONAL capability mid-run skips the step, never halts", async () => {
  // Fresh eligible paper so the reconcile step assembles again.
  const { invoice } = await createDraft(
    {
      firmId,
      supplierPartyId: clientX,
      buyerPartyId: buyerQ,
      invoiceNumber: `RECON-${SALT}-3`,
      issueDate: daysAgo(15),
      dueDate: null,
      lines: [
        { description: "Services", quantity: "1", unitPrice: "500", vatRate: "0.075" },
      ],
    },
    userId,
  );
  await getDb()
    .update(invoicesTable)
    .set({ status: "stamped" })
    .where(eq(invoicesTable.id, invoice.id));
  const [pLate] = await getDb()
    .insert(matchProposalsTable)
    .values({
      firmId,
      statementLineId: lineB,
      invoiceId: invoice.id,
      confidence: "0.9400",
    })
    .returning({ id: matchProposalsTable.id });
  const run = await createPlanRunFromTemplate("month_end_close", clientX, principal);
  assert.deepEqual(run.steps[0].proposalTargets, [pLate.id]);
  // Demote the approver to a client login: invoice.write survives,
  // reconciliation.act does not — creation would simply have omitted the
  // step for this principal.
  await getDb()
    .update(membershipsTable)
    .set({ role: "client_user", clientPartyId: clientX })
    .where(
      and(eq(membershipsTable.userId, userId), eq(membershipsTable.firmId, firmId)),
    );
  try {
    await driveToTerminal(run.id);
    const done = await loadRun(run.id);
    assert.equal(done.status, "done", "an optional step never halts the plan");
    assert.equal(done.steps[0].status, "skipped");
    assert.equal(done.steps[0].executedCount, 0);
    const [late] = await getDb()
      .select({ status: matchProposalsTable.status })
      .from(matchProposalsTable)
      .where(eq(matchProposalsTable.id, pLate.id));
    assert.equal(late.status, "proposed", "nothing was accepted");
  } finally {
    await getDb()
      .update(membershipsTable)
      .set({ role: "firm_admin", clientPartyId: null })
      .where(
        and(eq(membershipsTable.userId, userId), eq(membershipsTable.firmId, firmId)),
      );
  }
});

test("every terminal template-run path signals the close pack (round 35)", () => {
  const source = src("modules/clerk/plan-runs.ts");
  assert.equal(
    source.match(/await notifyClosePackBestEffort\(run\)/g)?.length,
    5,
    "halt, failed_targets, done, the optional-skip completion and the defensive re-terminalize all deliver the close pack, awaited",
  );
  assert.ok(
    source.includes("if (!run.templateKey) return;"),
    "case-origin runs stay quiet — their approver is watching",
  );
});

test("templates never outgrow the plan-step cap", () => {
  for (const t of Object.values(PLAN_TEMPLATES)) {
    assert.ok(t.kinds.length <= MAX_PLAN_STEPS, `${t.title} exceeds MAX_PLAN_STEPS`);
  }
});
