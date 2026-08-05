import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  getDb,
  clerkActionDecisionsTable,
  clerkCasesTable,
  clerkPlanRunsTable,
  engagementsTable,
  featureFlagsTable,
  firmsTable,
  invoicesTable,
  membershipsTable,
  partiesTable,
  usersTable,
} from "@workspace/db";
import { createDraft } from "../invoice/service.ts";
import { setFirmOverride } from "../flags/flags.ts";
import type { Principal } from "../auth/rbac.ts";
import { ACTIONS_FLAG_KEY } from "./actions.ts";
import {
  createPlanRunFromCase,
  createPlanRunFromTemplate,
  processPlanRun,
} from "./plan-runs.ts";
import {
  restoreClerkFlag,
  saveAndEnableClerkFlag,
} from "./test-support.ts";
import { daysAgo, makeRunSalt } from "../../test-helpers/fixtures.ts";
import { firmPrincipal as makeFirmPrincipal } from "../../test-helpers/principals.ts";
import { grantComplianceConsent } from "../../test-helpers/seeders.ts";

// Plan runs (round 32, Do with Clerk Phase 2). Pinned invariants:
//  - whole-plan approval freezes the steps SERVER-SIDE from the stored Ask
//    answer (guarded re-read) or a template's live assembly — and creation
//    executes NOTHING; the worker does, one step per slice, each step
//    writing its own decision-ledger row linked by planRunId;
//  - the approver is re-validated before every step (current membership
//    must still carry the kind's capability) — losing it HALTS the run;
//  - a terminal run cannot be claimed again (no double execution);
//  - a dark actions flag PARKS the run intact;
//  - SEC-03: a foreign firm's (or sibling client's) case is NOT_FOUND.

const SALT = makeRunSalt();

const firmId = randomUUID();
const foreignFirmId = randomUUID();
const userId = randomUUID();
const clientA = randomUUID();
const clientB = randomUUID(); // engaged, no paper
const buyer = randomUUID();

const principal: Principal = makeFirmPrincipal(firmId, { userId });

let overdue1: string;
let overdue2: string;

async function driveToTerminal(runId: string): Promise<void> {
  // The create paths also KICK asynchronously; driving explicitly here
  // races it safely — a claimed slice answers noop and we try again.
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

async function loadRun(runId: string) {
  const [row] = await getDb()
    .select()
    .from(clerkPlanRunsTable)
    .where(eq(clerkPlanRunsTable.id, runId));
  return row;
}

function caseAnswerWith(
  actions: Array<{ kind: string; clientPartyId: string; invoiceIds: string[] }>,
) {
  return {
    answered: true,
    proposition: "test",
    facts: [],
    sections: actions.map((a, i) => ({
      title: `step ${i}`,
      text: "test",
      facts: [],
      action: {
        kind: a.kind,
        clientPartyId: a.clientPartyId,
        clientName: `Client ${i}`,
        why: "test",
        targetCount: a.invoiceIds.length,
        truncated: false,
        invoiceIds: a.invoiceIds,
      },
    })),
  };
}

async function seedCase(
  answer: unknown,
  overrides: Partial<typeof clerkCasesTable.$inferInsert> = {},
): Promise<string> {
  const [kase] = await getDb()
    .insert(clerkCasesTable)
    .values({
      kind: "question",
      status: "approved",
      question: `run this ${SALT}`,
      answer: answer as never,
      firmId,
      createdBy: userId,
      ...overrides,
    })
    .returning({ id: clerkCasesTable.id });
  return kase.id;
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
    .values({ id: userId, email: `plan-runs-${SALT}@test.local` })
    .onConflictDoNothing();
  await db.insert(firmsTable).values([
    { id: firmId, name: `PlanRun Firm ${SALT}` },
    { id: foreignFirmId, name: `PlanRun Foreign ${SALT}` },
  ]);
  await setFirmOverride(ACTIONS_FLAG_KEY, firmId, true);
  // The approver's CURRENT membership is what step execution re-validates.
  await db.insert(membershipsTable).values({
    userId,
    firmId,
    role: "firm_admin",
  });
  await db.insert(partiesTable).values([
    {
      id: clientA,
      type: "client_business",
      legalName: `PlanRun Alpha ${SALT}`,
      tin: "50000000-0001",
      street: "1 Marina Rd",
      city: "Lagos",
    },
    {
      id: clientB,
      type: "client_business",
      legalName: `PlanRun Beta ${SALT}`,
      tin: "50000000-0002",
      street: "2 Marina Rd",
      city: "Lagos",
    },
    {
      id: buyer,
      type: "buyer",
      legalName: `PlanRun Buyer ${SALT}`,
      tin: "60000000-0001",
      street: "3 Broad St",
      city: "Lagos",
    },
  ]);
  await db.insert(engagementsTable).values([
    { firmId, clientPartyId: clientA, type: "readiness_assessment", title: "pa" },
    { firmId, clientPartyId: clientB, type: "readiness_assessment", title: "pb" },
  ]);
  await grantComplianceConsent(clientA, userId);
  const LINE = {
    description: "Goods",
    quantity: "1",
    unitPrice: "1000",
    vatRate: "0.075",
  };
  let n = 0;
  const draft = async (issueDate: string) => {
    n += 1;
    const bundle = await createDraft(
      {
        firmId,
        supplierPartyId: clientA,
        buyerPartyId: buyer,
        invoiceNumber: `PLANRUN-${SALT}-${n}`,
        issueDate,
        dueDate: null,
        lines: [LINE],
      },
      userId,
    );
    return bundle.invoice.id;
  };
  overdue1 = await draft(daysAgo(30));
  overdue2 = await draft(daysAgo(20));
});

after(async () => {
  await restoreClerkFlag();
});

test("whole-plan approval from a case: frozen steps, worker-executed, ledger-linked", async () => {
  const caseId = await seedCase(
    caseAnswerWith([
      { kind: "submit_overdue", clientPartyId: clientA, invoiceIds: [overdue1, overdue2] },
    ]),
  );
  const run = await createPlanRunFromCase(caseId, principal);
  assert.equal(run.caseId, caseId);
  assert.equal(run.steps.length, 1);
  assert.deepEqual(run.steps[0].invoiceIds, [overdue1, overdue2]);

  await driveToTerminal(run.id);
  const settled = await loadRun(run.id);
  assert.equal(settled.status, "done");
  assert.equal(settled.steps[0].status, "executed");
  assert.ok(settled.steps[0].decisionId, "the step names its decision row");
  assert.equal(settled.steps[0].executedCount, 2);

  // The decision row carries the run's id — the accountability link.
  const [decision] = await getDb()
    .select()
    .from(clerkActionDecisionsTable)
    .where(eq(clerkActionDecisionsTable.id, settled.steps[0].decisionId!));
  assert.equal(decision.planRunId, run.id);
  assert.equal(decision.decidedBy, userId);

  // The paper actually moved.
  const [inv] = await getDb()
    .select({ status: invoicesTable.status })
    .from(invoicesTable)
    .where(eq(invoicesTable.id, overdue1));
  assert.notEqual(inv.status, "draft");

  // A terminal run cannot be claimed again — no double execution.
  assert.equal(await processPlanRun(run.id), "noop");
});

test("SEC-03 walls: foreign firm case and answers without action steps refuse", async () => {
  const foreignCase = await seedCase(
    caseAnswerWith([
      { kind: "submit_overdue", clientPartyId: clientA, invoiceIds: [overdue1] },
    ]),
    { firmId: foreignFirmId },
  );
  await assert.rejects(
    createPlanRunFromCase(foreignCase, principal),
    /not found/i,
  );

  const noActions = await seedCase({
    answered: true,
    proposition: "plain",
    facts: [],
  });
  await assert.rejects(
    createPlanRunFromCase(noActions, principal),
    /no action proposals/i,
  );
});

test("a template assembles live batches; a client with nothing eligible is a 409", async () => {
  await assert.rejects(
    createPlanRunFromTemplate("month_end_close", clientB, principal),
    /Nothing is currently eligible/i,
  );
  // clientA's overdue paper was consumed by the first test's run; template
  // assembly reflects whatever is live NOW, so just assert the shape when
  // something is eligible OR the honest 409 — deterministically, seed one
  // fresh overdue draft first.
  const bundle = await createDraft(
    {
      firmId,
      supplierPartyId: clientA,
      buyerPartyId: buyer,
      invoiceNumber: `PLANRUN-${SALT}-T1`,
      issueDate: daysAgo(25),
      dueDate: null,
      lines: [
        { description: "Goods", quantity: "1", unitPrice: "1000", vatRate: "0.075" },
      ],
    },
    userId,
  );
  const run = await createPlanRunFromTemplate("month_end_close", clientA, principal);
  assert.equal(run.templateKey, "month_end_close");
  assert.ok(run.steps.some((s) => s.kind === "submit_overdue"));
  assert.ok(
    run.steps
      .find((s) => s.kind === "submit_overdue")!
      .invoiceIds.includes(bundle.invoice.id),
  );
  await driveToTerminal(run.id);
  assert.equal((await loadRun(run.id)).status, "done");
});

test("losing the approver's capability halts the run; remaining steps skip", async () => {
  const caseId = await seedCase(
    caseAnswerWith([
      { kind: "submit_overdue", clientPartyId: clientA, invoiceIds: [overdue1] },
      { kind: "retry_failed", clientPartyId: clientA, invoiceIds: [overdue1] },
    ]),
  );
  // Create while the membership still stands, then remove it before the
  // worker gets there — the grantor_inactive discipline, per step.
  const membership = await getDb()
    .delete(membershipsTable)
    .where(
      and(eq(membershipsTable.userId, userId), eq(membershipsTable.firmId, firmId)),
    )
    .returning();
  try {
    // Creation itself is fine (capability judged on the principal); the
    // PROCESSOR re-validates against the membership row and halts.
    const run = await createPlanRunFromCase(caseId, principal);
    await driveToTerminal(run.id);
    const settled = await loadRun(run.id);
    assert.equal(settled.status, "halted");
    assert.equal(settled.haltReason, "approver_inactive");
    assert.equal(settled.steps[0].status, "halted_here");
    assert.equal(settled.steps[1].status, "skipped");
    assert.equal(settled.steps[1].decisionId, null, "skipped steps ran nothing");
  } finally {
    await getDb().insert(membershipsTable).values(membership);
  }
});

test("a dark actions flag parks the run intact", async () => {
  // Seed the queued row directly — the create paths KICK asynchronously,
  // which would race the flag flip; the park path is the processor's own
  // and deserves a deterministic pin.
  const [run] = await getDb()
    .insert(clerkPlanRunsTable)
    .values({
      firmId,
      steps: [
        {
          kind: "submit_overdue",
          clientPartyId: clientA,
          clientName: "Client 0",
          invoiceIds: [overdue2],
          status: "pending",
          decisionId: null,
          executedCount: 0,
          failedCount: 0,
          skippedCount: 0,
        },
      ],
      approvedBy: userId,
    })
    .returning();
  await setFirmOverride(ACTIONS_FLAG_KEY, firmId, false);
  try {
    assert.equal(await processPlanRun(run.id), "noop");
    const parked = await loadRun(run.id);
    assert.equal(parked.status, "queued", "the dark flag parks, never runs");
    assert.equal(parked.claimedAt, null, "the claim is released");
    assert.equal(parked.steps[0].status, "pending", "nothing executed");
    assert.equal(parked.steps[0].invoiceIds.length, 1, "content intact");
  } finally {
    await setFirmOverride(ACTIONS_FLAG_KEY, firmId, true);
  }
});
