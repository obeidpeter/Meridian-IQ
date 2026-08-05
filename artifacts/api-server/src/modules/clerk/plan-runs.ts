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
import { notifyGrantorSignal, tooManyFailures } from "./action-policies";
import {
  assembleDraftRecurring,
  assembleReconcileMatches,
  deterministicCapability,
  executeDraftRecurring,
  executeReconcileMatches,
  isDeterministicKind,
  type DeterministicStepKind,
} from "./plan-steps";
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
// Well above worst-case step time (a 50-target submit batch or a
// degraded-provider window) — a reclaim mid-step would run it twice on two
// instances (round-32 review m5); the heartbeat below refreshes the claim
// before each step regardless.
const RECLAIM_AFTER_MS = 30 * 60_000;
// A queued run nobody could execute (dark flag, dead kick) must not sit as
// a standing instruction forever — the sweep halts it honestly (round-32
// review M4).
const PLAN_RUN_EXPIRY_MS = 72 * 60 * 60_000;

// Only these kinds may ride a plan run (round-32 review M3): draft_chasers
// is deliberately EXCLUDED — chaser drafts exist only on the execute
// response by design (nothing is stored, SEC-12), so a background worker
// would burn the firm's model tokens and hand the text to nobody. Chaser
// sections are approved individually, where the drafts land in front of
// the approver.
export const PLAN_RUNNABLE_KINDS: ReadonlySet<ActionKind> = new Set([
  "submit_overdue",
  "retry_failed",
]);

// A template step is an action-catalogue kind OR a deterministic kind
// (round 34, Close with Clerk — see plan-steps.ts). Case-origin plans can
// only carry catalogue kinds (Ask's sections are catalogue-shaped);
// deterministic kinds enter through templates alone.
export type PlanStepKind = ActionKind | DeterministicStepKind;

// The deterministic template registry. Kinds run in order; each step is
// assembled per the run's client at CREATION time (approval approves what
// was shown — executeAction re-checks at execution regardless).
// month_end_close raises the missing recurring paper FIRST, then repairs
// submissions: the submit step's targets were frozen at approval, so a
// draft this run just created can never ride the same run's submit batch.
export const PLAN_TEMPLATES: Record<
  string,
  { title: string; kinds: PlanStepKind[] }
> = {
  month_end_close: {
    title: "Month-end close",
    kinds: [
      "reconcile_matches",
      "draft_recurring",
      "submit_overdue",
      "retry_failed",
    ],
  },
};

// OPTIONAL kinds (round 35): offered only to approvers who hold their
// capability — reconciliation.act is firm-staff work, and the month-end
// button must keep working for a client_user with the steps they CAN run.
// The plan-policy grantor re-validation (templateCapabilities) excludes
// these for the same reason: a client-granted recurring close must not
// auto-pause grantor_inactive just because the template grew a staff-only
// optional step. The reconcile kind also self-gates on its own flag at
// assembly, so dark firms never see it either way.
export const OPTIONAL_PLAN_KINDS: ReadonlySet<PlanStepKind> = new Set([
  "reconcile_matches",
]);

// Postgres unique-violation detection (the action-policies cause-chain
// walk): the live-case unique index turns concurrent whole-plan approvals
// of one case into a clean 409 instead of duplicate runs.
function isUniqueViolation(err: unknown): boolean {
  for (let e = err; e; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: string }).code === "23505") return true;
  }
  return false;
}

function capabilityFor(
  kind: PlanStepKind,
): "invoice.submit" | "clerk.capture" | "invoice.write" | "reconciliation.act" {
  if (isDeterministicKind(kind)) return deterministicCapability(kind);
  const intent = ACTION_INTENTS.find((a) => a.kind === kind);
  // The catalogue is closed; an unknown kind cannot reach here through
  // either origin (case sections carry catalogue kinds; templates are
  // code). Defensive default matches the execute route's ternary.
  return intent?.capability ?? "invoice.submit";
}

// Every capability a template's steps demand — the plan-policy sweep's
// fail-fast grantor re-validation derives from THIS (round-34 review m4),
// so a template gaining a new step class can never silently outrun the
// stored grant's check.
export function templateCapabilities(
  templateKey: string,
): Array<"invoice.submit" | "clerk.capture" | "invoice.write" | "reconciliation.act"> {
  const template = PLAN_TEMPLATES[templateKey];
  if (!template) return [];
  // REQUIRED kinds only: an optional kind is skipped for approvers who
  // lack its capability, so it must not fail the grantor fail-fast check.
  return [
    ...new Set(
      template.kinds
        .filter((k) => !OPTIONAL_PLAN_KINDS.has(k))
        .map(capabilityFor),
    ),
  ];
}

async function assertKindCapabilities(
  principal: Principal,
  kinds: PlanStepKind[],
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
    "caseId" | "templateKey" | "steps" | "approvedBy" | "approvedByRole"
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
        targets:
          s.invoiceIds.length +
          (s.buyerTargets?.length ?? 0) +
          (s.proposalTargets?.length ?? 0),
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
  // No silent truncation (round-32 review note): an answer carrying more
  // action sections than a run may hold refuses whole — approval must mean
  // ALL of what was shown. Unreachable today (Ask's plan cap is 3), but a
  // cap change must not quietly change what "approve whole plan" means.
  if (actions.length > MAX_PLAN_STEPS) {
    throw new DomainError(
      "TOO_MANY_STEPS",
      `A plan run holds at most ${MAX_PLAN_STEPS} steps`,
      400,
    );
  }
  // Chaser sections are approved individually (see PLAN_RUNNABLE_KINDS):
  // refuse, never silently subset — the approver clicked "whole plan".
  if (actions.some((a) => !PLAN_RUNNABLE_KINDS.has(a.kind))) {
    throw new DomainError(
      "PLAN_UNRUNNABLE",
      "Payment-reminder drafts must be approved individually so the drafts land in front of you — approve the other sections as a plan and the reminder section on its own",
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
  const steps: PlanRunStep[] = actions.map((a) => ({
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
  let run: ClerkPlanRun;
  try {
    run = await insertRun(
      firmId,
      {
        caseId,
        templateKey: null,
        steps,
        approvedBy: principal.userId,
        approvedByRole: principal.role,
      },
      principal.userId,
    );
  } catch (err) {
    // The live-case unique index: a concurrent whole-plan approval of the
    // same case already minted a run — answer 409, never a duplicate.
    if (isUniqueViolation(err)) {
      throw new DomainError(
        "ALREADY_RUNNING",
        "A plan run for this answer is already queued or running",
        409,
      );
    }
    throw err;
  }
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
  opts: { policyMinted?: boolean } = {},
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
  // Optional kinds an approver cannot execute drop out of THEIR plan
  // (round 35): what remains is asserted in full — required kinds still
  // 403 an under-capable approver.
  // Optional kinds never ride POLICY-MINTED runs (round-35 review M2): a
  // recurring grant was consented against the template as it stood at
  // grant time, and template growth plus an operator-lit flag must not
  // quietly expand a standing authorization into unattended settlement no
  // consent copy ever described. A HUMAN-approved run may carry them —
  // the approver sees the step and its target count before approving.
  const offeredKinds = template.kinds.filter(
    (k) =>
      !OPTIONAL_PLAN_KINDS.has(k) ||
      (!opts.policyMinted && can(principal, capabilityFor(k))),
  );
  await assertKindCapabilities(principal, offeredKinds);
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
  const blankCounts = {
    status: "pending" as const,
    decisionId: null,
    executedCount: 0,
    failedCount: 0,
    skippedCount: 0,
  };
  const steps: PlanRunStep[] = [];
  for (const kind of offeredKinds) {
    if (isDeterministicKind(kind)) {
      // Deterministic assembly, frozen as the step's targets — execution
      // re-derives and only acts on targets still eligible. Reconcile: the
      // best high-confidence proposal per statement line (self-gated on
      // its own flag — dark assembles nothing). Draft: the (buyer,
      // currency) pairs whose recurring pattern is unbilled RIGHT NOW.
      if (kind === "reconcile_matches") {
        const targets = await inClerkScope(firmId, () =>
          assembleReconcileMatches(firmId, clientPartyId),
        );
        if (targets.length === 0) continue;
        steps.push({
          kind,
          clientPartyId,
          clientName: party?.name ?? "",
          invoiceIds: [],
          proposalTargets: targets,
          ...blankCounts,
        });
        continue;
      }
      const targets = await inClerkScope(firmId, () =>
        assembleDraftRecurring(firmId, clientPartyId),
      );
      if (targets.length === 0) continue;
      steps.push({
        kind,
        clientPartyId,
        clientName: party?.name ?? "",
        invoiceIds: [],
        buyerTargets: targets,
        ...blankCounts,
      });
      continue;
    }
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
    {
      caseId: null,
      templateKey,
      steps,
      approvedBy: principal.userId,
      approvedByRole: principal.role,
    },
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
  const capability = capabilityFor(step.kind as PlanStepKind);
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

// The close pack's delivery half (round 35, Close with Clerk Phase 3): a
// TEMPLATE run reaching a terminal state — done or halted — signals its
// approver through the shared grantor router, because a policy-minted run
// executes with nobody watching and its results (created drafts awaiting
// review, a halt needing a human) must not wait for a dashboard visit.
// Case-origin runs stay quiet: their approver is watching the progress
// card that second. Pointer-only (SEC-12): the run row in the app carries
// what ran, what moved and what needs review. Best-effort by design.
async function notifyClosePack(run: ClerkPlanRun): Promise<void> {
  if (!run.templateKey) return;
  const clientPartyId = run.steps[0]?.clientPartyId;
  if (!clientPartyId) return;
  // Route from the role RECORDED AT APPROVAL (round-35 review m8): a
  // delivery-time membership heuristic would send a staff approver who
  // also holds a client login for this party down the PARTY rails, where
  // the pack lands in every client_user's inbox while getPlanRun hides
  // the run from all of them. Pre-35 rows (null role) fall back to the
  // heuristic; misrouting to "firm_staff" is harmless — the staff branch
  // re-verifies membership itself and sends nothing to non-staff.
  let role = run.approvedByRole;
  if (!role) {
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
    role = memberships.some(
      (m) => m.role === "client_user" && m.clientPartyId === clientPartyId,
    )
      ? "client_user"
      : "firm_staff";
  }
  await notifyGrantorSignal(
    {
      id: run.id,
      firmId: run.firmId,
      clientPartyId,
      grantedBy: run.approvedBy,
      grantedByRole: role,
    },
    "clerk_plan_run",
    "close_pack_ready",
    "run",
  );
}

// Awaited at every terminal site (round-35 review note): the promise is
// failure-absorbed, and leaving it dangling would let a scale-to-zero
// right after the terminal slice drop the one signal a policy-minted run
// ever sends.
async function notifyClosePackBestEffort(run: ClerkPlanRun): Promise<void> {
  try {
    await notifyClosePack(run);
  } catch (err) {
    logger.warn({ err, runId: run.id }, "plan run: close-pack signal failed");
  }
}

// One step per call. The claim is taken fresh each slice; the run's own
// steps jsonb is the ledger of what happened. Every terminal write is
// fence-checked BEFORE its audit (round-32 review m6): a stale instance
// that lost its claim must neither audit nor overwrite the winner.
export async function processPlanRun(runId: string): Promise<PlanSliceOutcome> {
  const claimed = await claimRun(runId);
  if (!claimed) return "noop";
  const { run } = claimed;
  let stamp = claimed.stamp;

  const steps = [...run.steps];
  const cursor = run.processedSteps;
  if (cursor >= steps.length) {
    const held = await fencedPatch(runId, stamp, { status: "done", claimedAt: null });
    if (held) await notifyClosePackBestEffort(run);
    return "terminal";
  }
  const step = steps[cursor];

  const finishHalt = async (reason: string): Promise<PlanSliceOutcome> => {
    steps[cursor] = { ...step, status: "halted_here" };
    for (let i = cursor + 1; i < steps.length; i++) {
      steps[i] = { ...steps[i], status: "skipped" };
    }
    const held = await fencedPatch(runId, stamp, {
      status: "halted",
      haltReason: reason,
      steps,
      processedSteps: steps.length,
      claimedAt: null,
    });
    if (!held) return "noop";
    await appendAudit({
      actorId: null,
      firmId: run.firmId,
      action: "clerk.plan_run.halted",
      entityType: "clerk_plan_run",
      entityId: run.id,
      after: { step: cursor, kind: step.kind, reason },
    });
    await notifyClosePackBestEffort(run);
    return "terminal";
  };

  // Expiry (round-32 review M4): a run nobody could execute for days — a
  // firm whose flag stayed dark, a kick that died with no live sweep — is
  // a stale standing instruction, not a queue entry. Halt it honestly.
  if (run.createdAt.getTime() < Date.now() - PLAN_RUN_EXPIRY_MS) {
    return finishHalt("expired");
  }

  // Kill switch: a dark flag PARKS the run back in the queue with content
  // intact — flipping it back on resumes where it left off.
  if (!(await isFeatureEnabled(ACTIONS_FLAG_KEY, run.firmId))) {
    await fencedPatch(runId, stamp, { status: "queued", claimedAt: null });
    return "noop";
  }

  const role = await approverRole(run, step);
  if (!role) {
    // An OPTIONAL step the approver can no longer run is SKIPPED, not a
    // halt (round-35 review m6): creation would simply have omitted it
    // for that principal, so losing the optional capability mid-run must
    // not kill the statutory steps behind it — or next month's recurring
    // policy. A required step's approver going inactive still halts.
    if (OPTIONAL_PLAN_KINDS.has(step.kind as PlanStepKind)) {
      steps[cursor] = { ...step, status: "skipped" };
      const nextCursor = cursor + 1;
      const held = await fencedPatch(runId, stamp, {
        status: nextCursor >= steps.length ? "done" : "queued",
        steps,
        processedSteps: nextCursor,
        claimedAt: null,
      });
      if (!held) return "noop";
      if (nextCursor >= steps.length) {
        await notifyClosePackBestEffort(run);
        return "terminal";
      }
      return "more";
    }
    return finishHalt("approver_inactive");
  }

  // Heartbeat (round-32 review m5): refresh the claim RIGHT BEFORE the
  // step — a slow batch must not let the stale-reclaim window open behind
  // an old stamp while executeAction is mid-flight.
  const freshStamp = new Date();
  const heartbeat = await fencedPatch(runId, stamp, { claimedAt: freshStamp });
  if (!heartbeat) return "noop";
  stamp = freshStamp;

  const principal: Principal = {
    userId: run.approvedBy,
    role,
    firmId: run.firmId,
    clientPartyId: role === "client_user" ? step.clientPartyId : null,
    buyerPartyId: null,
  };
  // The half-rule inputs, filled by BOTH branches (round-34 review M2: the
  // deterministic executor catches per-target failures too, and a step
  // whose drafts all fail must halt the plan exactly like a submit batch
  // whose targets all fail).
  let requestedCount = 0;
  let failedCount = 0;
  try {
    if (isDeterministicKind(step.kind)) {
      // Deterministic step (rounds 34-35): platform SQL + the platform's
      // own safe writes under the approver's authority — no decision row;
      // the rows it creates/decides (each audited against this run) and
      // the run's audits are the ledger.
      const outcome =
        step.kind === "reconcile_matches"
          ? await executeReconcileMatches(
              run.firmId,
              step.clientPartyId,
              step.proposalTargets ?? [],
              { userId: run.approvedBy, role },
              run.id,
            )
          : await executeDraftRecurring(
              run.firmId,
              step.clientPartyId,
              step.buyerTargets ?? [],
              run.approvedBy,
              run.id,
            );
      steps[cursor] = {
        ...step,
        status: "executed",
        draftIds: outcome.draftIds,
        executedCount: outcome.executed,
        failedCount: outcome.failed,
        skippedCount: outcome.skipped,
      };
      requestedCount =
        (step.buyerTargets?.length ?? 0) + (step.proposalTargets?.length ?? 0);
      failedCount = outcome.failed;
    } else {
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
      requestedCount = decision.requestedCount;
      failedCount = decision.failedCount;
    }
    // The per-step tripwire: the autopilot's half-rule over what THIS step
    // requested. A plan is a sequence — a badly failing step must not let
    // the next one pile on.
    if (tooManyFailures(requestedCount, failedCount)) {
      steps[cursor] = { ...steps[cursor], status: "halted_here" };
      for (let i = cursor + 1; i < steps.length; i++) {
        steps[i] = { ...steps[i], status: "skipped" };
      }
      const held = await fencedPatch(runId, stamp, {
        status: "halted",
        haltReason: "failed_targets",
        steps,
        processedSteps: steps.length,
        claimedAt: null,
      });
      if (!held) return "noop";
      await appendAudit({
        actorId: null,
        firmId: run.firmId,
        action: "clerk.plan_run.halted",
        entityType: "clerk_plan_run",
        entityId: run.id,
        after: { step: cursor, kind: step.kind, reason: "failed_targets" },
      });
      await notifyClosePackBestEffort(run);
      return "terminal";
    }
  } catch (err) {
    logger.warn({ err, runId, step: cursor }, "plan run: step failed");
    return finishHalt("step_error");
  }

  const nextCursor = cursor + 1;
  if (nextCursor >= steps.length) {
    const held = await fencedPatch(runId, stamp, {
      status: "done",
      steps,
      processedSteps: nextCursor,
      claimedAt: null,
    });
    if (!held) return "noop";
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
    await notifyClosePackBestEffort(run);
    return "terminal";
  }
  // More steps remain: persist progress and release the claim so the next
  // slice (kick loop or sweep) picks it up fresh. A lost fence here means a
  // reclaimer owns the run — its decision row exists and will be re-linked
  // when the reclaimer re-runs the step (targets skip via re-validation).
  const held = await fencedPatch(runId, stamp, {
    status: "queued",
    steps,
    processedSteps: nextCursor,
    claimedAt: null,
  });
  return held ? "more" : "noop";
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

// One slice of the oldest RUNNABLE claimable run per pass (the sweep loop
// is every minute; a run advances step by step even if every kick dies).
// Flag peek BEFORE claiming (round-32 review M4, the batch sweep's
// budget-peek precedent): a dark firm's queued run must not be claimed and
// re-parked every minute forever — two writes a pass — nor block every
// other firm's runs behind it at the head of the line. Expired runs are
// processed regardless of the flag so their expiry halt can terminalize
// them.
export async function sweepPlanRuns(): Promise<void> {
  const staleBefore = new Date(Date.now() - RECLAIM_AFTER_MS);
  const candidates = await runInBypassContext(() =>
    getDb()
      .select({
        id: clerkPlanRunsTable.id,
        firmId: clerkPlanRunsTable.firmId,
        createdAt: clerkPlanRunsTable.createdAt,
      })
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
      .limit(10),
  );
  const expiryBefore = Date.now() - PLAN_RUN_EXPIRY_MS;
  for (const c of candidates) {
    const expired = c.createdAt.getTime() < expiryBefore;
    if (!expired && !(await isFeatureEnabled(ACTIONS_FLAG_KEY, c.firmId))) {
      continue;
    }
    await processPlanRun(c.id);
    return;
  }
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
