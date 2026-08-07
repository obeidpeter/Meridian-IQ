import { and, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  runRequestContext,
  auditEventsTable,
  clerkPlanPoliciesTable,
  clerkPlanRunsTable,
  engagementsTable,
  membershipsTable,
  type ClerkPlanPolicy,
} from "@workspace/db";
import { appendAudit } from "../audit/audit";
import { DomainError } from "../errors";
import { isUniqueViolation } from "../../lib/pg-errors";
import { logger } from "../../lib/logger";
import { lagosDateString } from "../../lib/lagos-time";
import {
  ROLE_CAPABILITIES,
  assertClientPartyScope,
  type Principal,
} from "../auth/rbac";
import { isFeatureEnabled } from "../flags/flags";
import { isPurposePermitted } from "../consent/consent";
import { registerSweep } from "../pipeline/pipeline";
import { alertOnceViaAuditLedger, atMostHourly } from "./watch-shared";
import { ACTIONS_FLAG_KEY } from "./actions";
import {
  POLICIES_FLAG_KEY,
  notifyAutoPause,
  notifyPolicyGranted,
} from "./action-policies";
import {
  PLAN_TEMPLATES,
  createPlanRunFromTemplate,
  templateCapabilities,
} from "./plan-runs";

// Do with Clerk Phase 3 (round 33): recurring plan policies — a standing
// approval of a TEMPLATE per client. Once per Lagos month the sweep
// assembles the template and runs it as an ordinary plan run under the
// grantor's authority; the plan-run processor then re-validates the
// grantor before EVERY step, so this module's checks are the fail-fast
// layer, not the wall. The action-policies spine applies verbatim:
//  - double fail-closed flag gate (clerk_actions AND clerk_action_policies
//    — recurrence is the same standing-instruction risk class);
//  - grant walls: live engagement, CORE-03 consent, one live grant per
//    (firm, client, template) with a clean 409;
//  - the month claim is a CAS on lastRunMonth (the lastRunDay pattern), so
//    concurrent instances mint at most one run;
//  - tripwires auto-pause (CAS; only the winner notifies through the
//    SHARED grantor-signal helpers, messaging kill switch inside):
//    a previous run that HALTED, a grantor whose membership no longer
//    carries the capability, a closed engagement, lapsed consent, an
//    unknown template, or a sweep error (fail closed — the month may
//    already be claimed, so "log and retry" would hammer forever).
// The grantor capabilities in question are DERIVED from the template's
// step kinds (invoice.submit for the action kinds, invoice.write for the
// round-34 draft step) — see grantorStillValid.

export type PlanPolicyPauseReason =
  | "manual"
  | "run_halted"
  | "grantor_inactive"
  | "engagement_closed"
  | "consent_missing"
  | "unknown_template"
  | "run_error";

async function planPoliciesEnabled(firmId: string): Promise<boolean> {
  return (
    (await isFeatureEnabled(ACTIONS_FLAG_KEY, firmId)) &&
    (await isFeatureEnabled(POLICIES_FLAG_KEY, firmId))
  );
}

// Reads via the ambient getDb() (the action-policies discipline): the grant
// path already runs in the caller's request context — wrapping again would
// hold a SECOND pool connection per grant — and the sweep, which has no
// ambient context, wraps this at ITS call site firm-bound.
async function hasLiveEngagement(
  firmId: string,
  clientPartyId: string,
): Promise<boolean> {
  const rows = await getDb()
    .select({ id: engagementsTable.id })
    .from(engagementsTable)
    .where(
      and(
        eq(engagementsTable.firmId, firmId),
        eq(engagementsTable.clientPartyId, clientPartyId),
        sql`${engagementsTable.status} IN ('open', 'in_progress')`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}


// ---- Lifecycle -------------------------------------------------------------

export interface PlanPolicyList {
  policies: ClerkPlanPolicy[];
  enabled: boolean;
}

export async function listPlanPolicies(
  firmId: string,
  clientPartyId: string,
): Promise<PlanPolicyList> {
  const policies = await getDb()
    .select()
    .from(clerkPlanPoliciesTable)
    .where(
      and(
        eq(clerkPlanPoliciesTable.firmId, firmId),
        eq(clerkPlanPoliciesTable.clientPartyId, clientPartyId),
        isNull(clerkPlanPoliciesTable.revokedAt),
      ),
    );
  return { policies, enabled: await planPoliciesEnabled(firmId) };
}

export async function grantPlanPolicy(
  firmId: string,
  clientPartyId: string,
  principal: Principal,
  templateKey: string,
): Promise<ClerkPlanPolicy> {
  const input = { templateKey, clientPartyId };
  if (!PLAN_TEMPLATES[input.templateKey]) {
    throw new DomainError(
      "UNKNOWN_TEMPLATE",
      "That plan template does not exist",
      400,
    );
  }
  if (!(await planPoliciesEnabled(firmId))) {
    throw new DomainError(
      "POLICIES_DISABLED",
      "Standing approvals are not enabled for this deployment",
      503,
    );
  }
  // The route asserted assertPartyAccess in-transaction (the action-policy
  // grant route's wall); the SEC-03 client pin re-asserts here.
  if (principal.role === "client_user") {
    assertClientPartyScope(principal, input.clientPartyId);
  }
  if (!(await hasLiveEngagement(firmId, input.clientPartyId))) {
    throw new DomainError(
      "NO_LIVE_ENGAGEMENT",
      "The firm has no open engagement with this client — a standing approval needs a live relationship",
      409,
    );
  }
  if (!(await isPurposePermitted(input.clientPartyId, "compliance_submission"))) {
    throw new DomainError(
      "CONSENT_REQUIRED",
      "The client's consent for compliance submission is not in force",
      403,
    );
  }
  const [existing] = await getDb()
    .select({ id: clerkPlanPoliciesTable.id })
    .from(clerkPlanPoliciesTable)
    .where(
      and(
        eq(clerkPlanPoliciesTable.firmId, firmId),
        eq(clerkPlanPoliciesTable.clientPartyId, input.clientPartyId),
        eq(clerkPlanPoliciesTable.templateKey, input.templateKey),
        isNull(clerkPlanPoliciesTable.revokedAt),
      ),
    )
    .limit(1);
  if (existing) {
    throw new DomainError(
      "POLICY_EXISTS",
      "A standing approval for this plan already exists — revoke it first",
      409,
    );
  }
  let policy: ClerkPlanPolicy;
  try {
    [policy] = await getDb()
      .insert(clerkPlanPoliciesTable)
      .values({
        firmId,
        clientPartyId: input.clientPartyId,
        templateKey: input.templateKey,
        grantedBy: principal.userId,
        grantedByRole: principal.role,
      })
      .returning();
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new DomainError(
        "POLICY_EXISTS",
        "A standing approval for this plan already exists — revoke it first",
        409,
      );
    }
    throw err;
  }
  await appendAudit({
    actorId: principal.userId,
    actorRole: principal.role,
    firmId,
    action: "clerk.plan_policy_granted",
    entityType: "clerk_plan_policy",
    entityId: policy.id,
    after: { templateKey: policy.templateKey },
  });
  try {
    await notifyPolicyGranted(policy, "clerk_plan_policy");
  } catch (err) {
    logger.warn({ err, policyId: policy.id }, "plan policy: grant signal failed");
  }
  return policy;
}

async function loadPolicyForUpdate(
  firmId: string,
  id: string,
  principal: Principal,
): Promise<ClerkPlanPolicy> {
  const [policy] = await getDb()
    .select()
    .from(clerkPlanPoliciesTable)
    .where(
      and(
        eq(clerkPlanPoliciesTable.id, id),
        eq(clerkPlanPoliciesTable.firmId, firmId),
      ),
    )
    .limit(1);
  if (!policy) throw new DomainError("NOT_FOUND", "Plan policy not found", 404);
  assertClientPartyScope(principal, policy.clientPartyId);
  return policy;
}

export async function pausePlanPolicy(
  firmId: string,
  id: string,
  principal: Principal,
): Promise<ClerkPlanPolicy> {
  const policy = await loadPolicyForUpdate(firmId, id, principal);
  if (policy.revokedAt) {
    throw new DomainError(
      "POLICY_REVOKED",
      "A revoked standing approval cannot be paused",
      409,
    );
  }
  if (policy.pausedAt) return policy;
  const [updated] = await getDb()
    .update(clerkPlanPoliciesTable)
    .set({
      pausedAt: new Date(),
      pausedReason: "manual",
      pausedBy: principal.userId,
    })
    .where(eq(clerkPlanPoliciesTable.id, id))
    .returning();
  await appendAudit({
    actorId: principal.userId,
    actorRole: principal.role,
    firmId,
    action: "clerk.plan_policy_paused",
    entityType: "clerk_plan_policy",
    entityId: id,
    after: { reason: "manual" },
  });
  return updated;
}

export async function resumePlanPolicy(
  firmId: string,
  id: string,
  principal: Principal,
): Promise<ClerkPlanPolicy> {
  const policy = await loadPolicyForUpdate(firmId, id, principal);
  if (policy.revokedAt) {
    throw new DomainError(
      "POLICY_REVOKED",
      "A revoked standing approval cannot be resumed — grant a new one",
      409,
    );
  }
  if (!policy.pausedAt) return policy;
  const clearedReason = policy.pausedReason;
  const [updated] = await getDb()
    .update(clerkPlanPoliciesTable)
    .set({ pausedAt: null, pausedReason: null, pausedBy: null })
    .where(eq(clerkPlanPoliciesTable.id, id))
    .returning();
  await appendAudit({
    actorId: principal.userId,
    actorRole: principal.role,
    firmId,
    action: "clerk.plan_policy_resumed",
    entityType: "clerk_plan_policy",
    entityId: id,
    after: { clearedReason },
  });
  return updated;
}

export async function revokePlanPolicy(
  firmId: string,
  id: string,
  principal: Principal,
): Promise<ClerkPlanPolicy> {
  const policy = await loadPolicyForUpdate(firmId, id, principal);
  if (policy.revokedAt) return policy;
  const [updated] = await getDb()
    .update(clerkPlanPoliciesTable)
    .set({ revokedAt: new Date(), revokedBy: principal.userId })
    .where(eq(clerkPlanPoliciesTable.id, id))
    .returning();
  await appendAudit({
    actorId: principal.userId,
    actorRole: principal.role,
    firmId,
    action: "clerk.plan_policy_revoked",
    entityType: "clerk_plan_policy",
    entityId: id,
    after: { templateKey: policy.templateKey },
  });
  return updated;
}

// Offboarding (the round-28 d2 precedent): a departing client's standing
// plan approvals end with the relationship — staff memberships survive and
// consent is client-owned, so no tripwire would otherwise catch it. Runs in
// the caller's (firm-scoped) transaction; audited per policy.
export async function revokePlanPoliciesForParty(
  firmId: string,
  partyId: string,
  actorId: string,
): Promise<number> {
  const revoked = await getDb()
    .update(clerkPlanPoliciesTable)
    .set({ revokedAt: new Date(), revokedBy: actorId })
    .where(
      and(
        eq(clerkPlanPoliciesTable.firmId, firmId),
        eq(clerkPlanPoliciesTable.clientPartyId, partyId),
        isNull(clerkPlanPoliciesTable.revokedAt),
      ),
    )
    .returning({
      id: clerkPlanPoliciesTable.id,
      templateKey: clerkPlanPoliciesTable.templateKey,
    });
  for (const p of revoked) {
    await appendAudit({
      actorId,
      firmId,
      action: "clerk.plan_policy_revoked",
      entityType: "clerk_plan_policy",
      entityId: p.id,
      after: { templateKey: p.templateKey, via: "offboard" },
    });
  }
  return revoked.length;
}

// ---- The monthly sweep -----------------------------------------------------

// CAS pause: only the winner audits and notifies (the autoPause pattern).
async function autoPausePlanPolicy(
  policy: ClerkPlanPolicy,
  reason: Exclude<PlanPolicyPauseReason, "manual">,
): Promise<boolean> {
  const won = await runInBypassContext(() =>
    getDb()
      .update(clerkPlanPoliciesTable)
      .set({ pausedAt: new Date(), pausedReason: reason, pausedBy: null })
      .where(
        and(
          eq(clerkPlanPoliciesTable.id, policy.id),
          isNull(clerkPlanPoliciesTable.pausedAt),
          isNull(clerkPlanPoliciesTable.revokedAt),
        ),
      )
      .returning({ id: clerkPlanPoliciesTable.id }),
  );
  if (won.length === 0) return false;
  await appendAudit({
    actorId: null,
    firmId: policy.firmId,
    action: "clerk.plan_policy_auto_paused",
    entityType: "clerk_plan_policy",
    entityId: policy.id,
    after: { templateKey: policy.templateKey, reason },
  });
  try {
    await notifyAutoPause(policy, "clerk_plan_policy");
  } catch (err) {
    logger.warn({ err, policyId: policy.id }, "plan policy: pause signal failed");
  }
  return true;
}

// The grantor's CURRENT standing (the grantorRole discipline): membership
// in this firm still carrying EVERY capability the template's steps demand,
// and a client_user grantor still pinned to this very party.
async function grantorStillValid(policy: ClerkPlanPolicy): Promise<Principal["role"] | null> {
  const memberships = await runInBypassContext(() =>
    getDb()
      .select({
        role: membershipsTable.role,
        clientPartyId: membershipsTable.clientPartyId,
      })
      .from(membershipsTable)
      .where(
        and(
          eq(membershipsTable.userId, policy.grantedBy),
          eq(membershipsTable.firmId, policy.firmId),
        ),
      ),
  );
  // Derived from the TEMPLATE, not hard-coded (round-34 review m4): the
  // month-end template now carries an invoice.write draft step beside the
  // submit kinds, and a template gaining a step class must tighten this
  // fail-fast check automatically. (Every current submit-holding role also
  // holds invoice.write; the derivation is the guarantee, not the matrix.)
  const required = templateCapabilities(policy.templateKey);
  const valid = memberships.find(
    (m) =>
      required.length > 0 &&
      required.every((cap) => ROLE_CAPABILITIES[m.role]?.includes(cap)) &&
      (m.role !== "client_user" || m.clientPartyId === policy.clientPartyId),
  );
  return valid?.role ?? null;
}

export type PlanPolicyRunOutcome =
  | "ran"
  | "ran_empty"
  | "auto_paused"
  | "skipped_dark"
  | "skipped_empty"
  | "skipped_raced";

// The last Lagos day of the month — the closing window in which an empty
// book finally consumes the month (see the NOTHING_TO_RUN branch below).
export function isLagosMonthClosing(dateStr: string = lagosDateString()): boolean {
  const [y, m, d] = dateStr.split("-").map(Number);
  return d === new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function prevMonthKey(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Give the month back (CAS-guarded: only while WE hold the claim). Used
// when the claim turned out to have nothing durable behind it — an empty
// book outside the closing window, a flag that went dark mid-claim, a run
// that errored (the pause dominates; un-claiming lets a human RESUME the
// policy and still get this month's run).
async function unclaimMonth(
  policy: ClerkPlanPolicy,
  monthKey: string,
  restoreTo: string | null,
): Promise<void> {
  await runInBypassContext(() =>
    getDb()
      .update(clerkPlanPoliciesTable)
      .set({ lastRunMonth: restoreTo })
      .where(
        and(
          eq(clerkPlanPoliciesTable.id, policy.id),
          eq(clerkPlanPoliciesTable.lastRunMonth, monthKey),
        ),
      ),
  );
}

// Exported for the closing-window tests: the sweep computes `closing` from
// the Lagos calendar; a test drives both branches deterministically.
export async function runOnePlanPolicy(
  policy: ClerkPlanPolicy,
  monthKey: string,
  closing: boolean,
): Promise<PlanPolicyRunOutcome> {
  // Kill switches beat grants — and a dark flag must NOT consume the month.
  if (!(await planPoliciesEnabled(policy.firmId))) return "skipped_dark";

  if (!PLAN_TEMPLATES[policy.templateKey]) {
    return (await autoPausePlanPolicy(policy, "unknown_template"))
      ? "auto_paused"
      : "skipped_raced";
  }

  // A previous run that HALTED is the plan-level tripwire: something about
  // this client's book made the workflow stop mid-way, and re-running it
  // monthly without a human look would repeat it forever.
  if (policy.lastRunId) {
    const [prev] = await runInBypassContext(() =>
      getDb()
        .select({ status: clerkPlanRunsTable.status })
        .from(clerkPlanRunsTable)
        .where(eq(clerkPlanRunsTable.id, policy.lastRunId!))
        .limit(1),
    );
    if (prev && (prev.status === "halted" || prev.status === "failed")) {
      return (await autoPausePlanPolicy(policy, "run_halted"))
        ? "auto_paused"
        : "skipped_raced";
    }
  }

  const role = await grantorStillValid(policy);
  if (!role) {
    return (await autoPausePlanPolicy(policy, "grantor_inactive"))
      ? "auto_paused"
      : "skipped_raced";
  }
  // Firm-bound contexts (the daily sweep's exact posture): both tables are
  // RLS-forced, and the sweep must never lean on a BYPASSRLS pool role for
  // reads the request paths do firm-scoped.
  const engaged = await runRequestContext(
    { bypass: false, firmId: policy.firmId },
    () => hasLiveEngagement(policy.firmId, policy.clientPartyId),
  );
  if (!engaged) {
    return (await autoPausePlanPolicy(policy, "engagement_closed"))
      ? "auto_paused"
      : "skipped_raced";
  }
  const consented = await runRequestContext(
    { bypass: false, firmId: policy.firmId },
    () => isPurposePermitted(policy.clientPartyId, "compliance_submission"),
  );
  if (!consented) {
    return (await autoPausePlanPolicy(policy, "consent_missing"))
      ? "auto_paused"
      : "skipped_raced";
  }

  // Claim the month (CAS): the loser of a concurrent race mints nothing.
  // The claim is provisional until something durable backs it — a minted
  // run or the closing-window empty audit; every other exit below gives
  // the month back, and the sweep's recovery scan gives back claims a
  // crash orphaned between here and the create.
  const priorMonth = policy.lastRunMonth;
  const claimed = await runInBypassContext(() =>
    getDb()
      .update(clerkPlanPoliciesTable)
      .set({ lastRunMonth: monthKey })
      .where(
        and(
          eq(clerkPlanPoliciesTable.id, policy.id),
          isNull(clerkPlanPoliciesTable.pausedAt),
          isNull(clerkPlanPoliciesTable.revokedAt),
          or(
            isNull(clerkPlanPoliciesTable.lastRunMonth),
            ne(clerkPlanPoliciesTable.lastRunMonth, monthKey),
          ),
        ),
      )
      .returning({ id: clerkPlanPoliciesTable.id }),
  );
  if (claimed.length === 0) return "skipped_raced";

  const principal: Principal = {
    userId: policy.grantedBy,
    role,
    firmId: policy.firmId,
    clientPartyId: role === "client_user" ? policy.clientPartyId : null,
    buyerPartyId: null,
  };
  let run;
  try {
    // policyMinted: optional (staff-only, separately-flagged) kinds never
    // ride a recurring run — the grant was consented against the template
    // as it stood at grant time (round-35 review M2).
    run = await createPlanRunFromTemplate(
      policy.templateKey,
      policy.clientPartyId,
      principal,
      { policyMinted: true },
    );
  } catch (err) {
    if (err instanceof DomainError && err.code === "NOTHING_TO_RUN") {
      // Nothing eligible RIGHT NOW — but eligibility changes daily as
      // submission windows lapse and rails reject, so an early empty pass
      // must not write off the month (the daily sweep's own
      // leave-the-day-unclaimed rule, at month granularity): give the
      // month back and let the first non-empty pass run. Only the CLOSING
      // window consumes an empty month, with the honest ledger row.
      if (!closing) {
        await unclaimMonth(policy, monthKey, priorMonth);
        return "skipped_empty";
      }
      await appendAudit({
        actorId: null,
        firmId: policy.firmId,
        action: "clerk.plan_policy_ran",
        entityType: "clerk_plan_policy",
        entityId: policy.id,
        after: {
          templateKey: policy.templateKey,
          month: monthKey,
          runId: null,
          empty: true,
        },
      });
      return "ran_empty";
    }
    if (err instanceof DomainError && err.code === "ACTIONS_DISABLED") {
      // The flag went dark between our gate and the create (TOCTOU): dark
      // is a skip, never a consumed month or a tripwire.
      await unclaimMonth(policy, monthKey, priorMonth);
      return "skipped_dark";
    }
    // Fail closed: pause + signal — "log and leave live" would retry-hammer
    // with the same defect. The month is given back so that a human who
    // fixes the cause and RESUMES the policy still gets this month's run.
    logger.error({ err, policyId: policy.id }, "plan policy sweep: run failed");
    await unclaimMonth(policy, monthKey, priorMonth);
    return (await autoPausePlanPolicy(policy, "run_error"))
      ? "auto_paused"
      : "skipped_raced";
  }
  // Bookkeeping stays OUTSIDE the catch: the run exists and is executing —
  // a failure here must not read as run_error and pause the policy. A throw
  // lands in the sweep's per-policy isolation; the recovery scan sees a
  // claim without a marker next pass and re-runs, where the already-run
  // targets re-validate as ineligible.
  await runInBypassContext(() =>
    getDb()
      .update(clerkPlanPoliciesTable)
      .set({ lastRunId: run.id })
      .where(eq(clerkPlanPoliciesTable.id, policy.id)),
  );
  await appendAudit({
    actorId: null,
    firmId: policy.firmId,
    action: "clerk.plan_policy_ran",
    entityType: "clerk_plan_policy",
    entityId: policy.id,
    after: { templateKey: policy.templateKey, month: monthKey, runId: run.id },
  });
  return "ran";
}

// Every legitimate month claim leaves a durable marker: the ran path minted
// a plan run this Lagos month, the closing-window empty path wrote its
// audit. A claim with neither is a crash leak (death between the CAS and
// the create) — without recovery the policy silently sits out the WHOLE
// month while the UI says it ran.
async function monthClaimHasMarker(
  policy: ClerkPlanPolicy,
  monthKey: string,
): Promise<boolean> {
  if (policy.lastRunId) {
    const [run] = await runInBypassContext(() =>
      getDb()
        .select({ createdAt: clerkPlanRunsTable.createdAt })
        .from(clerkPlanRunsTable)
        .where(eq(clerkPlanRunsTable.id, policy.lastRunId!))
        .limit(1),
    );
    if (run && lagosDateString(run.createdAt).slice(0, 7) === monthKey) {
      return true;
    }
  }
  const audits = await runInBypassContext(() =>
    getDb()
      .select({ after: auditEventsTable.after })
      .from(auditEventsTable)
      .where(
        and(
          eq(auditEventsTable.action, "clerk.plan_policy_ran"),
          eq(auditEventsTable.entityId, policy.id),
        ),
      )
      .orderBy(desc(auditEventsTable.createdAt))
      .limit(12),
  );
  return audits.some(
    (a) => (a.after as { month?: string } | null)?.month === monthKey,
  );
}

export interface PlanPolicySweepResult {
  policiesDue: number;
  policiesRun: number;
  policiesEmpty: number;
  policiesAutoPaused: number;
}

const SWEEP_ACTOR = "plan-policy-sweep";

// The operator signal that the sweep auto-paused SOMETHING (the daily
// sweep's round-30 discipline): the append-only audit ledger is the
// cross-instance dedup key; counts only — per-policy detail lives on each
// policy's own clerk.plan_policy_auto_paused row.
export const PLAN_POLICY_AUTO_PAUSE_ALERT = "ops.plan_policy.auto_paused";

const alertAutoPaused = alertOnceViaAuditLedger({
  action: PLAN_POLICY_AUTO_PAUSE_ALERT,
  entityType: "plan_policy_sweep",
  actorId: SWEEP_ACTOR,
});

export async function runPlanPolicySweep(): Promise<PlanPolicySweepResult> {
  // The Lagos month key ("YYYY-MM"): a new month makes every live policy
  // due; the CAS above makes each run at most once for it.
  const today = lagosDateString();
  const monthKey = today.slice(0, 7);
  const closing = isLagosMonthClosing(today);

  // Crash-leak recovery first: give orphaned claims back so THIS pass
  // re-runs them through the ordinary walls. A claim another instance made
  // seconds ago (mid-create) has no marker yet either — un-claiming it
  // risks one duplicate run, which per-step re-validation makes a no-op;
  // the safe direction against losing a whole month of submissions.
  const claimedNow = await runInBypassContext(() =>
    getDb()
      .select()
      .from(clerkPlanPoliciesTable)
      .where(
        and(
          isNull(clerkPlanPoliciesTable.pausedAt),
          isNull(clerkPlanPoliciesTable.revokedAt),
          eq(clerkPlanPoliciesTable.lastRunMonth, monthKey),
        ),
      ),
  );
  for (const policy of claimedNow) {
    try {
      if (await monthClaimHasMarker(policy, monthKey)) continue;
      logger.warn(
        { policyId: policy.id, month: monthKey },
        "plan policy sweep: recovering an orphaned month claim",
      );
      await unclaimMonth(policy, monthKey, prevMonthKey(monthKey));
    } catch (err) {
      logger.error(
        { err, policyId: policy.id },
        "plan policy sweep: claim recovery failed",
      );
    }
  }

  const due = await runInBypassContext(() =>
    getDb()
      .select()
      .from(clerkPlanPoliciesTable)
      .where(
        and(
          isNull(clerkPlanPoliciesTable.pausedAt),
          isNull(clerkPlanPoliciesTable.revokedAt),
          or(
            isNull(clerkPlanPoliciesTable.lastRunMonth),
            ne(clerkPlanPoliciesTable.lastRunMonth, monthKey),
          ),
        ),
      )
      .orderBy(clerkPlanPoliciesTable.createdAt, clerkPlanPoliciesTable.id),
  );
  const result: PlanPolicySweepResult = {
    policiesDue: due.length,
    policiesRun: 0,
    policiesEmpty: 0,
    policiesAutoPaused: 0,
  };
  for (const policy of due) {
    try {
      const outcome = await runOnePlanPolicy(policy, monthKey, closing);
      if (outcome === "ran" || outcome === "ran_empty") result.policiesRun += 1;
      if (outcome === "skipped_empty") result.policiesEmpty += 1;
      if (outcome === "auto_paused") result.policiesAutoPaused += 1;
    } catch (err) {
      // Per-policy isolation: one broken firm cannot stall the fleet.
      logger.error({ err, policyId: policy.id }, "plan policy sweep failed");
    }
  }
  // Fleet visibility (the daily sweep's round-30 discipline): one info line
  // per pass; NEW auto-pauses additionally raise the durable once-per-day
  // ledger alert. Best-effort — a failed alert never fails the sweep.
  logger.info(result, "plan-policy sweep: pass complete");
  if (result.policiesAutoPaused > 0) {
    try {
      await runInBypassContext(() =>
        alertAutoPaused(
          `auto-paused:${today}`,
          {
            ...result,
            day: today,
            reason:
              "The plan-policy sweep auto-paused recurring plans: tripwires fired and the affected automations are stopped until a human reviews and resumes them.",
          },
          "Recurring plan policies were auto-paused by the sweep; review the policy audit trail and the clients' monthly-automation strips.",
        ),
      );
    } catch (err) {
      logger.error({ err }, "plan-policy sweep: auto-pause alert failed");
    }
  }
  return result;
}

registerSweep(atMostHourly(runPlanPolicySweep));
