import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  runRequestContext,
  clerkPlanPoliciesTable,
  clerkPlanRunsTable,
  engagementsTable,
  membershipsTable,
  type ClerkPlanPolicy,
} from "@workspace/db";
import { appendAudit } from "../audit/audit";
import { DomainError } from "../errors";
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
import { atMostHourly } from "./watch-shared";
import { ACTIONS_FLAG_KEY } from "./actions";
import {
  POLICIES_FLAG_KEY,
  notifyAutoPause,
  notifyPolicyGranted,
} from "./action-policies";
import { PLAN_TEMPLATES, createPlanRunFromTemplate } from "./plan-runs";

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
// Templates only ever hold PLAN_RUNNABLE_KINDS (submit kinds), so the
// grantor capability in question is always invoice.submit.

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

async function hasLiveEngagement(
  firmId: string,
  clientPartyId: string,
): Promise<boolean> {
  const rows = await runRequestContext({ bypass: false, firmId }, () =>
    getDb()
      .select({ id: engagementsTable.id })
      .from(engagementsTable)
      .where(
        and(
          eq(engagementsTable.firmId, firmId),
          eq(engagementsTable.clientPartyId, clientPartyId),
          sql`${engagementsTable.status} IN ('open', 'in_progress')`,
        ),
      )
      .limit(1),
  );
  return rows.length > 0;
}

function isUniqueViolation(err: unknown): boolean {
  for (let e = err; e; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: string }).code === "23505") return true;
  }
  return false;
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

// The grantor's CURRENT standing (the grantorRole discipline): membership in
// this firm still carrying invoice.submit — templates only hold submit
// kinds — and a client_user grantor still pinned to this very party.
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
  const valid = memberships.find(
    (m) =>
      ROLE_CAPABILITIES[m.role]?.includes("invoice.submit") &&
      (m.role !== "client_user" || m.clientPartyId === policy.clientPartyId),
  );
  return valid?.role ?? null;
}

export type PlanPolicyRunOutcome =
  | "ran"
  | "ran_empty"
  | "auto_paused"
  | "skipped_dark"
  | "skipped_raced";

async function runOnePlanPolicy(
  policy: ClerkPlanPolicy,
  monthKey: string,
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
  if (!(await hasLiveEngagement(policy.firmId, policy.clientPartyId))) {
    return (await autoPausePlanPolicy(policy, "engagement_closed"))
      ? "auto_paused"
      : "skipped_raced";
  }
  if (!(await isPurposePermitted(policy.clientPartyId, "compliance_submission"))) {
    return (await autoPausePlanPolicy(policy, "consent_missing"))
      ? "auto_paused"
      : "skipped_raced";
  }

  // Claim the month (CAS): the loser of a concurrent race mints nothing.
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
  try {
    const run = await createPlanRunFromTemplate(
      policy.templateKey,
      policy.clientPartyId,
      principal,
    );
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
  } catch (err) {
    if (err instanceof DomainError && err.code === "NOTHING_TO_RUN") {
      // An honest empty month: nothing eligible for any step. The month
      // stays consumed (assembling again tomorrow would find the same
      // book) and the ledger says so; no run row exists.
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
    // Fail closed: the month is already claimed, so "log and leave live"
    // would retry-hammer next month with the same defect. Pause + signal.
    logger.error({ err, policyId: policy.id }, "plan policy sweep: run failed");
    return (await autoPausePlanPolicy(policy, "run_error"))
      ? "auto_paused"
      : "skipped_raced";
  }
}

export interface PlanPolicySweepResult {
  policiesDue: number;
  policiesRun: number;
  policiesAutoPaused: number;
}

export async function runPlanPolicySweep(): Promise<PlanPolicySweepResult> {
  // The Lagos month key ("YYYY-MM"): a new month makes every live policy
  // due; the CAS above makes each run at most once for it.
  const monthKey = lagosDateString().slice(0, 7);
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
    policiesAutoPaused: 0,
  };
  for (const policy of due) {
    try {
      const outcome = await runOnePlanPolicy(policy, monthKey);
      if (outcome === "ran" || outcome === "ran_empty") result.policiesRun += 1;
      if (outcome === "auto_paused") result.policiesAutoPaused += 1;
    } catch (err) {
      // Per-policy isolation: one broken firm cannot stall the fleet.
      logger.error({ err, policyId: policy.id }, "plan policy sweep failed");
    }
  }
  return result;
}

registerSweep(atMostHourly(runPlanPolicySweep));
