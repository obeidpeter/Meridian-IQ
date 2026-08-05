import { and, asc, eq, lt, or, sql } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  runRequestContext,
  clerkCasesTable,
  clerkPlanRunsTable,
  membershipsTable,
  partiesTable,
  type ClerkPlanRun,
  type PlanRunStep,
} from "@workspace/db";
import { appendAudit } from "../audit/audit";
import { DomainError } from "../errors";
import { logger } from "../../lib/logger";
import {
  ROLE_CAPABILITIES,
  assertClientPartyScope,
  assertPartyAccess,
  can,
  type Principal,
} from "../auth/rbac";
import { inClerkScope } from "./scope";
import {
  ACTION_INTENTS,
  ACTIONS_FLAG_KEY,
  executeAction,
  proposalForKind,
  type ActionKind,
} from "./actions";
import { tooManyFailures } from "./action-policies";
import { isFeatureEnabled } from "../flags/flags";
import { registerSweep } from "../pipeline/pipeline";
import type { AskAnswer } from "./ask";

// Do with Clerk Phase 2 (round 32): plan runs — an approved multi-step
// action plan executed by the pipeline worker, one step per slice, through
// the ordinary executeAction path. The batch processor's discipline applies
// verbatim (see batch-async.ts): claim by status CAS with a claimedAt
// fence/heartbeat, stale claims reclaimed by the sweep, every write fenced.
// Two origins, both deterministic:
//  - an Ask case whose action sections the approver accepted WHOLE — the
//    steps are re-read server-side from the stored answer (the
//    previousCaseId guard set: firm scope + explicit firm filter + kind +
//    approver-must-be-creator for client askers) and frozen at approval;
//  - a TEMPLATE — a code-defined sequence of action kinds assembled by
//    proposalForKind at approval time (the month-end close checklist made
//    executable). No model anywhere in this module.
// Safety spine: per-kind capability re-asserted at creation AND before
// every step (the approver as they stand TODAY, the policy sweep's
// grantorRole discipline); executeAction re-validates every target at
// execution; a step whose failures cross the autopilot's half-rule HALTS
// the run — remaining steps are skipped and say so.

export const MAX_PLAN_STEPS = 5;
const RECLAIM_AFTER_MS = 10 * 60_000;

// The deterministic template registry. Kinds run in order; each step is
// assembled per the run's client at CREATION time (approval approves what
// was shown — executeAction re-checks at execution regardless).
export const PLAN_TEMPLATES: Record<
  string,
  { title: string; kinds: ActionKind[] }
> = {
  month_end_close: {
    title: "Month-end close",
    kinds: ["submit_overdue", "retry_failed", "draft_chasers"],
  },
};

function capabilityFor(kind: ActionKind): "invoice.submit" | "clerk.capture" {
  const intent = ACTION_INTENTS.find((a) => a.kind === kind);
  // The catalogue is closed; an unknown kind cannot reach here through
  // either origin (case sections carry catalogue kinds; templates are
  // code). Defensive default matches the execute route's ternary.
  return intent?.capability ?? "invoice.submit";
}

async function assertKindCapabilities(
  principal: Principal,
  kinds: ActionKind[],
): Promise<void> {
  for (const kind of kinds) {
    if (!can(principal, capabilityFor(kind))) {
      throw new DomainError(
        "FORBIDDEN",
        `Approving a ${kind} step needs the ${capabilityFor(kind)} capability`,
        403,
      );
    }
  }
}

// ---- Creation --------------------------------------------------------------

async function insertRun(
  firmId: string,
  values: Pick<
    typeof clerkPlanRunsTable.$inferInsert,
    "caseId" | "templateKey" | "steps" | "approvedBy"
  >,
  actorId: string,
): Promise<ClerkPlanRun> {
  const [run] = await inClerkScope(firmId, () =>
    getDb()
      .insert(clerkPlanRunsTable)
      .values({ firmId, ...values })
      .returning(),
  );
  await appendAudit({
    actorId,
    firmId,
    action: "clerk.plan_run.approved",
    entityType: "clerk_plan_run",
    entityId: run.id,
    // Pointer-only: kinds and counts, never invoice ids or client names.
    after: {
      caseId: run.caseId,
      templateKey: run.templateKey,
      steps: run.steps.map((s) => ({
        kind: s.kind,
        targets: s.invoiceIds.length,
      })),
    },
  });
  return run;
}

// Whole-plan approval from an Ask case: re-read the stored answer under the
// full guard set and freeze its action sections as the run's steps. The
// case is the evidence of what the approver saw; nothing client-supplied
// reaches execution.
export async function createPlanRunFromCase(
  caseId: string,
  principal: Principal,
): Promise<ClerkPlanRun> {
  const firmId = principal.firmId;
  if (!firmId) {
    throw new DomainError("NO_TENANT", "Plan runs are firm-scoped", 403);
  }
  if (!(await isFeatureEnabled(ACTIONS_FLAG_KEY, firmId))) {
    throw new DomainError(
      "ACTIONS_DISABLED",
      "Clerk actions are not enabled for this deployment",
      503,
    );
  }
  const clientScoped = principal.role === "client_user";
  const [kase] = await inClerkScope(firmId, () =>
    getDb()
      .select({
        answer: clerkCasesTable.answer,
        createdBy: clerkCasesTable.createdBy,
      })
      .from(clerkCasesTable)
      .where(
        and(
          eq(clerkCasesTable.id, caseId),
          eq(clerkCasesTable.firmId, firmId),
          eq(clerkCasesTable.kind, "question"),
          // SEC-03: a client approver may only approve plans from its OWN
          // thread — firm-keyed RLS is not a sibling wall.
          ...(clientScoped
            ? [eq(clerkCasesTable.createdBy, principal.userId)]
            : []),
        ),
      )
      .limit(1),
  );
  if (!kase) {
    throw new DomainError("NOT_FOUND", "Question case not found", 404);
  }
  const answer = kase.answer as AskAnswer | null;
  const actions = (answer?.sections ?? [])
    .map((s) => s.action)
    .filter((a): a is NonNullable<typeof a> => !!a);
  if (actions.length === 0) {
    throw new DomainError(
      "NO_ACTION_STEPS",
      "This answer carries no action proposals to run",
      400,
    );
  }
  const kinds = actions.map((a) => a.kind);
  await assertKindCapabilities(principal, kinds);
  // SEC-03/IDOR wall per distinct client the plan touches (the execute
  // route's own posture, in an explicit firm-bound context because this
  // route runs outside the request transaction).
  for (const clientPartyId of [...new Set(actions.map((a) => a.clientPartyId))]) {
    await runRequestContext({ bypass: false, firmId }, () =>
      assertPartyAccess(principal, clientPartyId),
    );
    if (clientScoped) assertClientPartyScope(principal, clientPartyId);
  }
  const steps: PlanRunStep[] = actions.slice(0, MAX_PLAN_STEPS).map((a) => ({
    kind: a.kind,
    clientPartyId: a.clientPartyId,
    clientName: a.clientName,
    invoiceIds: a.invoiceIds,
    status: "pending",
    decisionId: null,
    executedCount: 0,
    failedCount: 0,
    skippedCount: 0,
  }));
  const run = await insertRun(
    firmId,
    { caseId, templateKey: null, steps, approvedBy: principal.userId },
    principal.userId,
  );
  kickPlanRunProcessing(run.id);
  return run;
}

// Template approval: assemble each kind's batch for the client NOW (the
// approver sees the counts in the response; executeAction re-checks at
// execution). Empty assemblies become no steps; an entirely empty template
// answers 409 rather than minting a run that would do nothing.
export async function createPlanRunFromTemplate(
  templateKey: string,
  clientPartyId: string,
  principal: Principal,
): Promise<ClerkPlanRun> {
  const firmId = principal.firmId;
  if (!firmId) {
    throw new DomainError("NO_TENANT", "Plan runs are firm-scoped", 403);
  }
  const template = PLAN_TEMPLATES[templateKey];
  if (!template) {
    throw new DomainError("UNKNOWN_TEMPLATE", "That plan template does not exist", 400);
  }
  if (!(await isFeatureEnabled(ACTIONS_FLAG_KEY, firmId))) {
    throw new DomainError(
      "ACTIONS_DISABLED",
      "Clerk actions are not enabled for this deployment",
      503,
    );
  }
  await assertKindCapabilities(principal, template.kinds);
  await runRequestContext({ bypass: false, firmId }, () =>
    assertPartyAccess(principal, clientPartyId),
  );
  if (principal.role === "client_user") {
    assertClientPartyScope(principal, clientPartyId);
  }
  const [party] = await inClerkScope(firmId, () =>
    getDb()
      .select({ name: partiesTable.legalName })
      .from(partiesTable)
      .where(eq(partiesTable.id, clientPartyId))
      .limit(1),
  );
  const steps: PlanRunStep[] = [];
  for (const kind of template.kinds) {
    const proposal = await inClerkScope(firmId, () =>
      proposalForKind(kind, firmId, clientPartyId),
    );
    if (!proposal || proposal.targets.length === 0) continue;
    steps.push({
      kind,
      clientPartyId,
      clientName: party?.name ?? "",
      invoiceIds: proposal.targets.map((t) => t.invoiceId),
      status: "pending",
      decisionId: null,
      executedCount: 0,
      failedCount: 0,
      skippedCount: 0,
    });
  }
  if (steps.length === 0) {
    throw new DomainError(
      "NOTHING_TO_RUN",
      "Nothing is currently eligible for any step of this template",
      409,
    );
  }
  const run = await insertRun(
    firmId,
    { caseId: null, templateKey, steps, approvedBy: principal.userId },
    principal.userId,
  );
  kickPlanRunProcessing(run.id);
  return run;
}

// ---- Processing ------------------------------------------------------------

// The approver as they stand TODAY (the policy sweep's grantorRole
// discipline): current membership must still carry the step's capability,
// and a client_user approver must still be pinned to the step's party.
async function approverRole(
  run: ClerkPlanRun,
  step: PlanRunStep,
): Promise<Principal["role"] | null> {
  const memberships = await runInBypassContext(() =>
    getDb()
      .select({
        role: membershipsTable.role,
        clientPartyId: membershipsTable.clientPartyId,
      })
      .from(membershipsTable)
      .where(
        and(
          eq(membershipsTable.userId, run.approvedBy),
          eq(membershipsTable.firmId, run.firmId),
        ),
      ),
  );
  const capability = capabilityFor(step.kind as ActionKind);
  const valid = memberships.find(
    (m) =>
      ROLE_CAPABILITIES[m.role]?.includes(capability) &&
      (m.role !== "client_user" || m.clientPartyId === step.clientPartyId),
  );
  return valid?.role ?? null;
}

type PlanSliceOutcome = "noop" | "terminal" | "more";

async function claimRun(
  runId: string,
): Promise<{ run: ClerkPlanRun; stamp: Date } | null> {
  const stamp = new Date();
  const staleBefore = new Date(stamp.getTime() - RECLAIM_AFTER_MS);
  const claimed = await runInBypassContext(() =>
    getDb()
      .update(clerkPlanRunsTable)
      .set({ status: "running", claimedAt: stamp, updatedAt: stamp })
      .where(
        and(
          eq(clerkPlanRunsTable.id, runId),
          or(
            eq(clerkPlanRunsTable.status, "queued"),
            and(
              eq(clerkPlanRunsTable.status, "running"),
              lt(clerkPlanRunsTable.claimedAt, staleBefore),
            ),
          ),
        ),
      )
      .returning(),
  );
  return claimed.length > 0 ? { run: claimed[0], stamp } : null;
}

// Fenced write: only the claim holder may patch; losing the fence means
// another instance reclaimed a stale run — stop writing immediately.
async function fencedPatch(
  runId: string,
  stamp: Date,
  patch: Partial<typeof clerkPlanRunsTable.$inferInsert>,
): Promise<boolean> {
  const rows = await runInBypassContext(() =>
    getDb()
      .update(clerkPlanRunsTable)
      .set({ ...patch, updatedAt: new Date() })
      .where(
        and(
          eq(clerkPlanRunsTable.id, runId),
          eq(clerkPlanRunsTable.status, "running"),
          eq(clerkPlanRunsTable.claimedAt, stamp),
        ),
      )
      .returning({ id: clerkPlanRunsTable.id }),
  );
  return rows.length > 0;
}

// One step per call. The claim is taken fresh each slice; the run's own
// steps jsonb is the ledger of what happened.
export async function processPlanRun(runId: string): Promise<PlanSliceOutcome> {
  const claimed = await claimRun(runId);
  if (!claimed) return "noop";
  const { run, stamp } = claimed;

  const steps = [...run.steps];
  const cursor = run.processedSteps;
  if (cursor >= steps.length) {
    await fencedPatch(runId, stamp, { status: "done", claimedAt: null });
    return "terminal";
  }
  const step = steps[cursor];

  const finishHalt = async (reason: string): Promise<PlanSliceOutcome> => {
    steps[cursor] = { ...step, status: "halted_here" };
    for (let i = cursor + 1; i < steps.length; i++) {
      steps[i] = { ...steps[i], status: "skipped" };
    }
    await fencedPatch(runId, stamp, {
      status: "halted",
      haltReason: reason,
      steps,
      processedSteps: steps.length,
      claimedAt: null,
    });
    await appendAudit({
      actorId: null,
      firmId: run.firmId,
      action: "clerk.plan_run.halted",
      entityType: "clerk_plan_run",
      entityId: run.id,
      after: { step: cursor, kind: step.kind, reason },
    });
    return "terminal";
  };

  // Kill switch: a dark flag PARKS the run back in the queue with content
  // intact — flipping it back on resumes where it left off.
  if (!(await isFeatureEnabled(ACTIONS_FLAG_KEY, run.firmId))) {
    await fencedPatch(runId, stamp, { status: "queued", claimedAt: null });
    return "noop";
  }

  const role = await approverRole(run, step);
  if (!role) return finishHalt("approver_inactive");

  const principal: Principal = {
    userId: run.approvedBy,
    role,
    firmId: run.firmId,
    clientPartyId: role === "client_user" ? step.clientPartyId : null,
    buyerPartyId: null,
  };
  try {
    const { decision } = await executeAction(
      run.firmId,
      step.clientPartyId,
      run.approvedBy,
      step.kind,
      step.invoiceIds,
      principal,
      { planRunId: run.id },
    );
    steps[cursor] = {
      ...step,
      status: "executed",
      decisionId: decision.id,
      executedCount: decision.executedCount,
      failedCount: decision.failedCount,
      skippedCount: decision.skippedCount,
    };
    // The per-step tripwire: the autopilot's half-rule over what THIS step
    // requested. A plan is a sequence — a badly failing step must not let
    // the next one pile on.
    if (tooManyFailures(decision.requestedCount, decision.failedCount)) {
      steps[cursor] = { ...steps[cursor], status: "halted_here" };
      for (let i = cursor + 1; i < steps.length; i++) {
        steps[i] = { ...steps[i], status: "skipped" };
      }
      await fencedPatch(runId, stamp, {
        status: "halted",
        haltReason: "failed_targets",
        steps,
        processedSteps: steps.length,
        claimedAt: null,
      });
      await appendAudit({
        actorId: null,
        firmId: run.firmId,
        action: "clerk.plan_run.halted",
        entityType: "clerk_plan_run",
        entityId: run.id,
        after: { step: cursor, kind: step.kind, reason: "failed_targets" },
      });
      return "terminal";
    }
  } catch (err) {
    logger.warn({ err, runId, step: cursor }, "plan run: step failed");
    return finishHalt("step_error");
  }

  const nextCursor = cursor + 1;
  if (nextCursor >= steps.length) {
    await fencedPatch(runId, stamp, {
      status: "done",
      steps,
      processedSteps: nextCursor,
      claimedAt: null,
    });
    await appendAudit({
      actorId: null,
      firmId: run.firmId,
      action: "clerk.plan_run.completed",
      entityType: "clerk_plan_run",
      entityId: run.id,
      after: {
        steps: steps.map((s) => ({
          kind: s.kind,
          status: s.status,
          executed: s.executedCount,
          failed: s.failedCount,
        })),
      },
    });
    return "terminal";
  }
  // More steps remain: persist progress and release the claim so the next
  // slice (kick loop or sweep) picks it up fresh.
  await fencedPatch(runId, stamp, {
    status: "queued",
    steps,
    processedSteps: nextCursor,
    claimedAt: null,
  });
  return "more";
}

// Fire-and-forget drive-to-terminal; the sweep is the retry.
export function kickPlanRunProcessing(runId: string): void {
  void (async () => {
    let outcome: PlanSliceOutcome;
    do {
      outcome = await processPlanRun(runId);
    } while (outcome === "more");
  })().catch((err) => {
    logger.warn({ err, runId }, "plan run kick failed; sweep will retry");
  });
}

// One slice of the oldest claimable run per pass (the sweep loop is every
// minute; a run advances step by step even if every kick dies).
export async function sweepPlanRuns(): Promise<void> {
  const staleBefore = new Date(Date.now() - RECLAIM_AFTER_MS);
  const [next] = await runInBypassContext(() =>
    getDb()
      .select({ id: clerkPlanRunsTable.id })
      .from(clerkPlanRunsTable)
      .where(
        or(
          eq(clerkPlanRunsTable.status, "queued"),
          and(
            eq(clerkPlanRunsTable.status, "running"),
            lt(clerkPlanRunsTable.claimedAt, staleBefore),
          ),
        ),
      )
      .orderBy(asc(clerkPlanRunsTable.createdAt))
      .limit(1),
  );
  if (next) await processPlanRun(next.id);
}

registerSweep(sweepPlanRuns);

// ---- Reads -----------------------------------------------------------------

export async function getPlanRun(
  runId: string,
  principal: Principal,
): Promise<ClerkPlanRun | null> {
  const firmId = principal.firmId;
  if (!firmId) return null;
  const [run] = await inClerkScope(firmId, () =>
    getDb()
      .select()
      .from(clerkPlanRunsTable)
      .where(
        and(
          eq(clerkPlanRunsTable.id, runId),
          eq(clerkPlanRunsTable.firmId, firmId),
          // SEC-03: a client_user sees only runs it approved (the batches
          // route's createdBy narrowing).
          ...(principal.role === "client_user"
            ? [eq(clerkPlanRunsTable.approvedBy, principal.userId)]
            : []),
        ),
      )
      .limit(1),
  );
  return run ?? null;
}

export async function listPlanRuns(
  principal: Principal,
  limit = 10,
): Promise<ClerkPlanRun[]> {
  const firmId = principal.firmId;
  if (!firmId) return [];
  return inClerkScope(firmId, () =>
    getDb()
      .select()
      .from(clerkPlanRunsTable)
      .where(
        and(
          eq(clerkPlanRunsTable.firmId, firmId),
          ...(principal.role === "client_user"
            ? [eq(clerkPlanRunsTable.approvedBy, principal.userId)]
            : []),
        ),
      )
      .orderBy(sql`${clerkPlanRunsTable.createdAt} DESC`)
      .limit(limit),
  );
}
