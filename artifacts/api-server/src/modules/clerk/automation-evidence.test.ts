import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  getDb,
  usersTable,
  firmsTable,
  membershipsTable,
  partiesTable,
  engagementsTable,
  invoicesTable,
  invoiceLifecycleEventsTable,
  bankStatementsTable,
  bankStatementLinesTable,
  matchProposalsTable,
  clerkPlanRunsTable,
  clerkActionDecisionsTable,
  recurringInvoiceTemplatesTable,
} from "@workspace/db";
import { createDraft } from "../invoice/service.ts";
import { appendAudit } from "../audit/audit.ts";
import {
  closedLagosMonthEnds,
  computeAutomationEvidence,
  computeAutomationShadowPending,
  EVIDENCE_WINDOW_MONTHS,
  type AutomationEvidenceKind,
} from "./automation-evidence.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";
import { makeFlagGuard } from "../../test-helpers/flags.ts";

// The backtest engine (Prove with Clerk Phase 1). Everything here replays
// against ONE frozen instant — computeAutomationEvidence's injectable `now`
// — so the seeded ledgers and the expected verdicts are absolute dates, not
// clock-relative guesses. The pins are the doctrine:
//  - recorded-ledger first: reconcile agreement comes from the proposals
//    table verbatim, with the top-of-line and machine-acceptance guards;
//  - replay only over durable facts: submit/retry verdicts derive from
//    issue dates and the append-only lifecycle ledger, with machine batches
//    and machine drafts excluded;
//  - the miner replay honors template coverage as it stood at each replay
//    instant.

const SALT = makeRunSalt();
const firmId = randomUUID();
const userId = randomUUID();
const clientX = randomUUID();
const buyerOps = randomUUID(); // carrier for submit/retry/reconcile fixtures
const buyerStopped = randomUUID(); // rhythm that ended → disagreement
const buyerLate = randomUUID(); // rhythm resumed late → agreement
const buyerCovered = randomUUID(); // template-covered → never an event

// Frozen evaluation instant: noon UTC is 13:00 Lagos, safely inside the day.
const NOW = new Date("2026-08-06T12:00:00Z");
const AS_OF = "2026-08-06";

const stmtId = randomUUID();
const lineAccepted = randomUUID();
const lineRejected = randomUUID();
const lineOutranked = randomUUID();
const lineDebit = randomUUID();
const linePending = randomUUID();
const lineMachine = randomUUID();

const planRunId = randomUUID();

function ts(day: string, hour = 9): Date {
  return new Date(`${day}T${String(hour).padStart(2, "0")}:00:00Z`);
}

let nInv = 0;
async function receivable(
  buyerPartyId: string,
  issueDate: string,
  opts: { status?: string; invoiceNumber?: string } = {},
): Promise<string> {
  nInv += 1;
  const { invoice } = await createDraft(
    {
      firmId,
      supplierPartyId: clientX,
      buyerPartyId,
      invoiceNumber: opts.invoiceNumber ?? `EVID-${SALT}-${nInv}`,
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
  if (opts.status) {
    await getDb()
      .update(invoicesTable)
      .set({ status: opts.status as never })
      .where(eq(invoicesTable.id, invoice.id));
  }
  return invoice.id;
}

async function lifecycle(
  invoiceId: string,
  toStatus: string,
  at: Date,
): Promise<void> {
  await getDb()
    .insert(invoiceLifecycleEventsTable)
    .values({
      invoiceId,
      firmId,
      fromStatus: null,
      toStatus: toStatus as never,
      actorId: userId,
      createdAt: at,
    });
}

before(async () => {
  const db = getDb();
  await db
    .insert(usersTable)
    .values({ id: userId, email: `evidence-${SALT}@test.local` })
    .onConflictDoNothing();
  await db
    .insert(firmsTable)
    .values({ id: firmId, name: `Evidence Firm ${SALT}` });
  await db
    .insert(membershipsTable)
    .values({ userId, firmId, role: "firm_admin" });
  await db.insert(partiesTable).values([
    {
      id: clientX,
      type: "client_business",
      legalName: `Evidence Client ${SALT}`,
      tin: "52000000-0001",
      street: "1 Marina Rd",
      city: "Lagos",
    },
    ...[buyerOps, buyerStopped, buyerLate, buyerCovered].map((id, i) => ({
      id,
      type: "buyer" as const,
      legalName: `Evidence Buyer ${SALT}-${i}`,
      tin: `62000000-000${i + 1}`,
      street: `${i + 2} Broad St`,
      city: "Lagos",
    })),
  ]);
  await db.insert(engagementsTable).values({
    firmId,
    clientPartyId: clientX,
    type: "readiness_assessment",
    title: "evidence",
  });

  // ---- submit_overdue: deadline = issue + 7 -------------------------------
  // LATE: issued Jun 27 (deadline Jul 4), first submitted Jul 17 by a human
  // — 13 days late; the autopilot would have saved those 13 days.
  const late = await receivable(buyerOps, "2026-06-27", {
    status: "stamped",
  });
  await lifecycle(late, "submitted", ts("2026-07-17"));
  // CANCELLED: crossed its deadline, never submitted, human killed it — a
  // genuine disagreement with "submit everything overdue".
  await receivable(buyerOps, "2026-06-17", { status: "cancelled" });
  // MACHINE: submitted late, but by a plan run — must not count as human
  // agreement (provenance discipline).
  const machine = await receivable(buyerOps, "2026-06-22", {
    status: "stamped",
  });
  await lifecycle(machine, "submitted", ts("2026-07-14"));
  // MACHINE DRAFT: behind the DRAFT-% wall — in no cohort, not even act-now.
  await receivable(buyerOps, "2026-06-20", {
    invoiceNumber: `DRAFT-20260620-${SALT.slice(0, 6)}`,
  });
  // PENDING: overdue and still unsubmitted today — the act-now cohort.
  await receivable(buyerOps, "2026-07-20");
  // ON-TIME: submitted inside the window — evidence for neither side.
  const onTime = await receivable(buyerOps, "2026-07-10", {
    status: "stamped",
  });
  await lifecycle(onTime, "submitted", ts("2026-07-13"));

  // ---- retry_failed -------------------------------------------------------
  // RETRIED: failed Jul 27, human resubmitted Jul 30 (3 days) → agreed.
  const retried = await receivable(buyerOps, "2026-07-25", {
    status: "stamped",
  });
  await lifecycle(retried, "submitted", ts("2026-07-26"));
  await lifecycle(retried, "failed", ts("2026-07-27"));
  await lifecycle(retried, "submitted", ts("2026-07-30"));
  // ABANDONED: failed then cancelled → disagreed.
  const abandoned = await receivable(buyerOps, "2026-07-25", {
    status: "cancelled",
  });
  await lifecycle(abandoned, "submitted", ts("2026-07-26"));
  await lifecycle(abandoned, "failed", ts("2026-07-28"));
  // STUCK: currently failed, zero attempts recorded → act-now cohort.
  const stuck = await receivable(buyerOps, "2026-07-25", {
    status: "failed",
  });
  await lifecycle(stuck, "submitted", ts("2026-07-26"));
  await lifecycle(stuck, "failed", ts("2026-07-29"));
  // MACHINE RETRY: resubmitted by a plan run → excluded from agreement.
  const machineRetry = await receivable(buyerOps, "2026-07-25", {
    status: "stamped",
  });
  await lifecycle(machineRetry, "submitted", ts("2026-07-26"));
  await lifecycle(machineRetry, "failed", ts("2026-07-27"));
  await lifecycle(machineRetry, "submitted", ts("2026-07-31"));

  // One plan run + one decision naming BOTH machine invoices as submitted:
  // the automation-rollup "auto" predicate (plan_run_id set) is the whole
  // exclusion — kind does not matter to the invoice-level guard.
  await db.insert(clerkPlanRunsTable).values({
    id: planRunId,
    firmId,
    templateKey: "month_end_close",
    status: "done",
    steps: [],
    approvedBy: userId,
  });
  await db.insert(clerkActionDecisionsTable).values({
    firmId,
    clientPartyId: clientX,
    kind: "submit_overdue",
    decidedBy: userId,
    planRunId,
    evidence: { requestedCount: 2, asOf: AS_OF },
    targets: [
      {
        invoiceId: machine,
        invoiceNumber: "m1",
        outcome: "submitted",
        error: null,
      },
      {
        invoiceId: machineRetry,
        invoiceNumber: "m2",
        outcome: "submitted",
        error: null,
      },
    ],
    requestedCount: 2,
    executedCount: 2,
    skippedCount: 0,
    failedCount: 0,
  });

  // ---- reconcile_matches --------------------------------------------------
  const matchable = async () =>
    receivable(buyerOps, "2026-07-01", { status: "stamped" });
  const rAccepted = await matchable();
  const rRejected = await matchable();
  const rOutrankedHi = await matchable();
  const rOutrankedLo = await matchable();
  const rDebit = await matchable();
  const rPending = await matchable();
  const rMachine = await matchable();

  await db.insert(bankStatementsTable).values({
    id: stmtId,
    firmId,
    clientPartyId: clientX,
    formatKey: "gtb_csv",
    status: "committed",
    lineCount: 6,
    parsedCount: 6,
  });
  const lineRows = [
    { id: lineAccepted, no: 1, direction: "credit" },
    { id: lineRejected, no: 2, direction: "credit" },
    { id: lineOutranked, no: 3, direction: "credit" },
    { id: lineDebit, no: 4, direction: "debit" },
    { id: linePending, no: 5, direction: "credit" },
    { id: lineMachine, no: 6, direction: "credit" },
  ];
  await db.insert(bankStatementLinesTable).values(
    lineRows.map((l) => ({
      id: l.id,
      statementId: stmtId,
      lineNo: l.no,
      valueDate: "2026-07-20",
      amount: "2150.00",
      direction: l.direction as never,
      narration: `EVID ${SALT} ${l.no}`,
      parseStatus: "parsed" as const,
      rawLine: `raw-${l.no}`,
    })),
  );
  const proposal = async (
    statementLineId: string,
    invoiceId: string,
    confidence: string,
    status: "proposed" | "accepted" | "rejected" | "superseded",
    decidedDay?: string,
  ) => {
    const [row] = await db
      .insert(matchProposalsTable)
      .values({
        firmId,
        statementLineId,
        invoiceId,
        confidence,
        status,
        createdAt: ts("2026-07-22"),
        ...(decidedDay
          ? { decidedByUserId: userId, decidedAt: ts(decidedDay) }
          : {}),
      })
      .returning({ id: matchProposalsTable.id });
    return row.id;
  };
  // Accepted top candidate, 3 days after minting → agreed, lead 3.
  await proposal(lineAccepted, rAccepted, "0.9500", "accepted", "2026-07-25");
  // Rejected top candidate → disagreed.
  await proposal(lineRejected, rRejected, "0.9200", "rejected", "2026-07-26");
  // The human accepted the WEAKER sibling: the outranked ≥bar proposal is
  // the disagreement; the accepted weaker one must NOT count as agreement
  // (the top-of-line guard).
  await proposal(lineOutranked, rOutrankedHi, "0.9400", "superseded");
  await proposal(
    lineOutranked,
    rOutrankedLo,
    "0.9100",
    "accepted",
    "2026-07-27",
  );
  // Debit-lane acceptance: the autopilot refuses the debit lane, so this is
  // evidence for nothing.
  await proposal(lineDebit, rDebit, "0.9300", "accepted", "2026-07-25");
  // Live ≥bar proposal → the act-now cohort.
  await proposal(linePending, rPending, "0.9100", "proposed");
  // Machine acceptance (plan step): excluded via the audit pointer.
  const pMachine = await proposal(
    lineMachine,
    rMachine,
    "0.9600",
    "accepted",
    "2026-07-28",
  );
  await appendAudit({
    actorId: userId,
    firmId,
    action: "clerk.plan_step.reconciled",
    entityType: "clerk_plan_run",
    entityId: planRunId,
    after: { kind: "reconcile_matches", proposalId: pMachine },
  });

  // ---- draft_recurring ----------------------------------------------------
  // buyerLate: 30-day rhythm whose last pre-gap invoice is 2026-05-23; the
  // cycle expected 2026-06-22 alerts at the Jun 30 month-end replay, and
  // the paper eventually arrived Jul 17 — agreement, 25 days late.
  for (const day of [
    "2026-01-23",
    "2026-02-22",
    "2026-03-24",
    "2026-04-23",
    "2026-05-23",
    "2026-07-17",
  ]) {
    await receivable(buyerLate, day, { status: "stamped" });
  }
  // buyerStopped's rhythm ended at 2026-04-15: expected 2026-05-15, alive
  // at the May 31 replay, window closed 2026-06-29 with nothing raised —
  // disagreement. (The submit/retry/reconcile fixtures ride buyerOps,
  // whose spans stay under the miner's 55-day floor — never a pattern.)
  for (const day of ["2026-01-15", "2026-02-14", "2026-03-16", "2026-04-15"]) {
    await receivable(buyerStopped, day, { status: "stamped" });
  }
  // buyerCovered: same shape as buyerLate but template-covered since
  // January — the miner's own exclusion, honored as of each replay instant.
  for (const day of [
    "2026-01-23",
    "2026-02-22",
    "2026-03-24",
    "2026-04-23",
    "2026-05-23",
  ]) {
    await receivable(buyerCovered, day, { status: "stamped" });
  }
  await db.insert(recurringInvoiceTemplatesTable).values({
    firmId,
    supplierPartyId: clientX,
    buyerPartyId: buyerCovered,
    name: `Evidence retainer ${SALT}`,
    cadence: "monthly",
    nextRunDate: "2026-09-01",
    active: true,
    lines: [
      {
        description: "Monthly retainer",
        quantity: "1",
        unitPrice: "2000",
        vatRate: "0.075",
      },
    ],
    createdByUserId: userId,
    createdAt: ts("2026-01-05"),
  });
});

function kindOf(
  kinds: AutomationEvidenceKind[],
  kind: AutomationEvidenceKind["kind"],
): AutomationEvidenceKind {
  const found = kinds.find((k) => k.kind === kind);
  assert.ok(found, `${kind} present`);
  return found;
}

test("closedLagosMonthEnds walks real month lengths across the year seam", () => {
  assert.deepEqual(closedLagosMonthEnds("2026-08-06", 6), [
    "2026-07-31",
    "2026-06-30",
    "2026-05-31",
    "2026-04-30",
    "2026-03-31",
    "2026-02-28",
  ]);
  assert.deepEqual(closedLagosMonthEnds("2026-02-10", 3), [
    "2026-01-31",
    "2025-12-31",
    "2025-11-30",
  ]);
});

test("the evidence report replays every kind against the frozen instant", async () => {
  const report = await computeAutomationEvidence(firmId, NOW);
  assert.equal(report.windowMonths, EVIDENCE_WINDOW_MONTHS);
  assert.equal(report.asOf, AS_OF);
  assert.deepEqual(
    report.kinds.map((k) => k.kind),
    ["reconcile_matches", "submit_overdue", "retry_failed", "draft_recurring"],
    "fixed kind order — the card renders positionally",
  );

  // reconcile: accepted top (agreed) / rejected top + outranked-superseded
  // (disagreed); the weaker accepted sibling, the debit acceptance and the
  // machine acceptance all excluded; one live proposal in act-now.
  const recon = kindOf(report.kinds, "reconcile_matches");
  assert.equal(recon.agreed, 1);
  assert.equal(recon.disagreed, 2);
  assert.equal(recon.sample, 3);
  assert.equal(recon.pending, 1);
  assert.equal(recon.agreementRate, 0.333);
  assert.equal(recon.medianLeadDays, 3);
  assert.equal(recon.exposureFloorNgn, null);
  assert.match(recon.note, /0\.90/);
  assert.match(recon.note, /20 per run/);

  // submit_overdue: one human late submission 13 days past the deadline;
  // one cancellation; the machine batch and the DRAFT-% invoice invisible;
  // one overdue invoice in act-now; the s.104 floor covers the late cohort.
  const submit = kindOf(report.kinds, "submit_overdue");
  assert.equal(submit.agreed, 1);
  assert.equal(submit.disagreed, 1);
  assert.equal(submit.pending, 1);
  assert.equal(submit.agreementRate, 0.5);
  assert.equal(submit.medianLeadDays, 13);
  assert.equal(submit.exposureFloorNgn, "25000");
  assert.match(submit.note, /would-have estimate/);

  // retry_failed: one human retry after 3 days; one abandonment; the
  // machine retry excluded; one stuck invoice under the cap in act-now.
  const retry = kindOf(report.kinds, "retry_failed");
  assert.equal(retry.agreed, 1);
  assert.equal(retry.disagreed, 1);
  assert.equal(retry.pending, 1);
  assert.equal(retry.medianLeadDays, 3);
  assert.match(retry.note, /5-attempt/);

  // draft_recurring: the resumed rhythm agreed (25 days late), the ended
  // rhythm disagreed, the template-covered twin invisible, nothing alerting
  // today.
  const draft = kindOf(report.kinds, "draft_recurring");
  assert.equal(draft.agreed, 1);
  assert.equal(draft.disagreed, 1);
  assert.equal(draft.sample, 2);
  assert.equal(draft.pending, 0);
  assert.equal(draft.agreementRate, 0.5);
  assert.equal(draft.medianLeadDays, 25);
  assert.match(draft.note, /as they stand today/);
});

test("clientPartyId narrows every cohort to one client (Phase 2)", async () => {
  // A sibling client with its own overdue paper: firm-wide counts grow, the
  // original client's scoped read does not, and the sibling's scoped read
  // sees only its own row — the resolver's stated both-keys contract.
  const clientY = randomUUID();
  const buyerY = randomUUID();
  const db = getDb();
  await db.insert(partiesTable).values([
    {
      id: clientY,
      type: "client_business",
      legalName: `Evidence Sibling ${SALT}`,
      tin: "52000000-0002",
      street: "9 Marina Rd",
      city: "Lagos",
    },
    {
      id: buyerY,
      type: "buyer",
      legalName: `Evidence Sibling Buyer ${SALT}`,
      tin: "62000000-0009",
      street: "9 Broad St",
      city: "Lagos",
    },
  ]);
  await db.insert(engagementsTable).values({
    firmId,
    clientPartyId: clientY,
    type: "readiness_assessment",
    title: "evidence-sibling",
  });
  const { invoice } = await createDraft(
    {
      firmId,
      supplierPartyId: clientY,
      buyerPartyId: buyerY,
      invoiceNumber: `EVID-Y-${SALT}`,
      issueDate: "2026-07-15",
      dueDate: null,
      lines: [
        {
          description: "Sibling goods",
          quantity: "1",
          unitPrice: "1000",
          vatRate: "0.075",
        },
      ],
    },
    userId,
  );
  assert.ok(invoice.id);

  const firmWide = await computeAutomationEvidence(firmId, NOW);
  assert.equal(
    kindOf(firmWide.kinds, "submit_overdue").pending,
    2,
    "firm-wide act-now sees both clients' overdue paper",
  );
  const scopedX = await computeAutomationEvidence(firmId, NOW, clientX);
  assert.equal(kindOf(scopedX.kinds, "submit_overdue").pending, 1);
  assert.equal(kindOf(scopedX.kinds, "submit_overdue").agreed, 1);
  assert.equal(kindOf(scopedX.kinds, "reconcile_matches").sample, 3);
  const scopedY = await computeAutomationEvidence(firmId, NOW, clientY);
  assert.equal(kindOf(scopedY.kinds, "submit_overdue").pending, 1);
  assert.equal(kindOf(scopedY.kinds, "submit_overdue").sample, 0);
  assert.equal(kindOf(scopedY.kinds, "reconcile_matches").sample, 0);
  assert.equal(kindOf(scopedY.kinds, "draft_recurring").sample, 0);
});

test("the shadow number sums only the DARK kinds' act-now cohorts (Phase 3)", async () => {
  // Missing flag rows read as dark (isFeatureEnabled's fail-closed default),
  // so the unguarded state IS the all-dark state: every cohort counts.
  // submit 2 (both clients) + retry 1 + reconcile 1 + draft 0.
  assert.equal(await computeAutomationShadowPending(firmId, NOW), 4);

  const actions = makeFlagGuard("clerk_actions");
  const reconciliation = makeFlagGuard("reconciliation");
  const autoReconcile = makeFlagGuard("clerk_auto_reconcile");
  await actions.saveAndSet(true);
  try {
    // Actions lit, reconcile pair still dark → only the reconcile backlog.
    assert.equal(await computeAutomationShadowPending(firmId, NOW), 1);
    await reconciliation.saveAndSet(true);
    await autoReconcile.saveAndSet(true);
    try {
      // Everything lit → no shadow to report (null, not zero).
      assert.equal(await computeAutomationShadowPending(firmId, NOW), null);
    } finally {
      await reconciliation.restore();
      await autoReconcile.restore();
    }
  } finally {
    await actions.restore();
  }
});

test("an empty firm answers zeros with null rates, never an error", async () => {
  const emptyFirm = randomUUID();
  await getDb()
    .insert(firmsTable)
    .values({ id: emptyFirm, name: `Evidence Empty ${SALT}` });
  const report = await computeAutomationEvidence(emptyFirm, NOW);
  for (const k of report.kinds) {
    assert.equal(k.sample, 0);
    assert.equal(k.agreed, 0);
    assert.equal(k.disagreed, 0);
    assert.equal(k.pending, 0);
    assert.equal(k.agreementRate, null);
    assert.equal(k.medianLeadDays, null);
  }
});
