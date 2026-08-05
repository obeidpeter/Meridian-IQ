import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  getDb,
  clerkPlanRunsTable,
  engagementsTable,
  featureFlagsTable,
  firmsTable,
  invoicesTable,
  invoiceLinesTable,
  membershipsTable,
  partiesTable,
  usersTable,
} from "@workspace/db";
import { createDraft } from "../invoice/service.ts";
import { setFirmOverride } from "../flags/flags.ts";
import type { Principal } from "../auth/rbac.ts";
import { ACTIONS_FLAG_KEY } from "./actions.ts";
import {
  assembleDraftRecurring,
  executeDraftRecurring,
} from "./plan-steps.ts";
import { createPlanRunFromTemplate, processPlanRun } from "./plan-runs.ts";
import {
  restoreClerkFlag,
  saveAndEnableClerkFlag,
} from "./test-support.ts";
import { isDomainError } from "../../test-helpers/assertions.ts";
import { daysAgo, makeRunSalt } from "../../test-helpers/fixtures.ts";
import { firmPrincipal as makeFirmPrincipal } from "../../test-helpers/principals.ts";
import { lagosDateString } from "../../lib/lagos-time.ts";

// Deterministic plan steps (round 34, Close with Clerk Phase 1). Pinned:
//  - assembly finds the unbilled monthly habit (and ONLY it);
//  - execution drafts ONLY approved buyers whose pattern still alerts —
//    approval is not a license to draft against a book that moved;
//  - the end-to-end template run raises the missing paper as DRAFTS with
//    the buyer's own newest lines, a placeholder number, no decision row,
//    and the draft ids as step evidence;
//  - the step is naturally idempotent: the created draft joins the mined
//    history, so the pattern stops alerting and a second run is the
//    honest NOTHING_TO_RUN.

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

test("assembly finds the unbilled monthly habit and only it", async () => {
  assert.deepEqual(await assembleDraftRecurring(firmId, clientX), [buyerP]);
});

test("execution drafts only APPROVED buyers whose pattern still alerts", async () => {
  // buyerQ was approved but never had a pattern; buyerP has the pattern
  // but was NOT approved — nothing may be drafted either way.
  const outcome = await executeDraftRecurring(firmId, clientX, [buyerQ], userId);
  assert.deepEqual(outcome, { draftIds: [], created: 0, skipped: 1 });
  const drafts = await getDb()
    .select({ id: invoicesTable.id })
    .from(invoicesTable)
    .where(
      and(
        eq(invoicesTable.firmId, firmId),
        eq(invoicesTable.supplierPartyId, clientX),
        eq(invoicesTable.status, "draft"),
      ),
    );
  assert.equal(drafts.length, 0, "an unapproved pattern is never drafted");
});

test("the template run raises the missing paper as drafts (end-to-end)", async () => {
  const run = await createPlanRunFromTemplate("month_end_close", clientX, principal);
  assert.equal(run.steps.length, 1, "only the draft step assembles");
  assert.equal(run.steps[0].kind, "draft_recurring");
  assert.deepEqual(run.steps[0].buyerPartyIds, [buyerP]);
  assert.deepEqual(run.steps[0].invoiceIds, []);

  await driveToTerminal(run.id);
  const done = await loadRun(run.id);
  assert.equal(done.status, "done");
  const step = done.steps[0];
  assert.equal(step.status, "executed");
  assert.equal(step.executedCount, 1);
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
    draft.invoiceNumber.startsWith("DRAFT-"),
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

test("the fresh draft closes the pattern — a second run is the honest empty", async () => {
  await assert.rejects(
    createPlanRunFromTemplate("month_end_close", clientX, principal),
    isDomainError("NOTHING_TO_RUN"),
  );
  // And no second draft exists: exactly one DRAFT-numbered invoice for the
  // pattern buyer, however many times the template is attempted.
  const drafts = await getDb()
    .select({ id: invoicesTable.id })
    .from(invoicesTable)
    .where(
      and(
        eq(invoicesTable.firmId, firmId),
        eq(invoicesTable.buyerPartyId, buyerP),
        inArray(invoicesTable.status, ["draft"]),
      ),
    );
  assert.equal(drafts.length, 1);
});
