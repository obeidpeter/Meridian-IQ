import { and, desc, eq, isNull, ne, or } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  runRequestContext,
  alertPreferencesTable,
  clerkActionPoliciesTable,
  membershipsTable,
  staffNotificationPreferencesTable,
  type ClerkActionPolicy,
} from "@workspace/db";
import { appendAudit } from "../audit/audit";
import { DomainError } from "../errors";
import { isFeatureEnabled } from "../flags/flags";
import { isPurposePermitted } from "../consent/consent";
import { fanOutAlert } from "../messaging/fan-out";
import { sendMessage } from "../messaging/messaging";
import { pointerEntityRef } from "../messaging/recipient-ref";
import { sendPushToUser } from "../push/push";
import {
  ACTIONS_FLAG_KEY,
  MAX_ACTION_TARGETS,
  executeAction,
  proposalForKind,
} from "./actions";
import { registerSweep } from "../pipeline/pipeline";
import { atMostHourly } from "./watch-shared";
import {
  ROLE_CAPABILITIES,
  assertClientPartyScope,
  type Principal,
} from "../auth/rbac";
import { lagosDateString } from "../../lib/lagos-time";

// Standing approvals (round 28 — the autopilot extension of the
// proposed-actions arc). Rounds 21-22 closed the advice→action gap but kept
// a human clicking APPROVE on every batch, every day. This module lets that
// human make the approval DURABLE instead: a policy row granting ONE action
// kind for ONE client, which the daily sweep then executes on their behalf
// — without moving the platform's hard line, because what the sweep runs is
// exactly the per-batch machinery a fresh click would run:
//
//  - The automatable catalogue is NARROWER than the action catalogue:
//    draft_chasers is excluded by design — its drafts exist only on the
//    HTTP response for a human to read and send, which an unattended sweep
//    cannot do. Only the submit kinds (whose outcomes are fully recorded
//    per invoice) can be standing-approved.
//  - A grant is not a bypass. Every sweep run RE-VALIDATES the world before
//    touching anything: both feature flags (kill switches win over grants),
//    the grantor's CURRENT membership (someone who lost invoice.submit — or
//    left the firm — cannot keep submitting via a stale grant), consent
//    (CORE-03 gates a standing authorization exactly like a fresh click),
//    and then executeAction re-checks every target's predicate per invoice
//    as always. The DECISION row records the run with policyId set and
//    decidedBy = the grantor — the approval chain stays one human deep.
//  - At most once per Lagos day, exactly once across instances: the sweep
//    claims the policy's lastRunDay cell with a compare-and-set BEFORE
//    executing; the loser of a concurrent claim skips. An empty assembly
//    does NOT consume the day — the hourly pass keeps watching and the
//    first non-empty batch of the day runs.
//  - The sweep polices itself. Tripwires PAUSE the policy (reversible,
//    audited, pausedBy null = the system): grantor_inactive,
//    consent_missing, and failed_targets (half or more of a run's targets
//    failing means something is structurally wrong — a human must look
//    before it runs again). Pause vs revoke is deliberate: pause keeps the
//    grant and stops the engine; revoke is permanent evidence — the row
//    survives, a partial unique index keeps one LIVE grant per
//    (firm, client, kind), and re-automating takes a fresh grant.
//  - Rollout is doubly fail-closed: clerk_action_policies (this module) is
//    layered ON clerk_actions — either flag dark means no grants, no runs
//    (unknown flag keys default to false, so shipping this code enables
//    nothing anywhere).
//
// Grant/list/pause/resume/revoke run INSIDE the ordinary request
// transaction (no model calls, short writes). The sweep runs outside any
// request: bypass reads for the cross-firm worklist and the policy-row
// writes, a firm-bound context for assembly, and executeAction's own
// per-target commits for execution (the bulk-approve posture).

export const POLICIES_FLAG_KEY = "clerk_action_policies";

// The automatable subset of the action catalogue (see the header).
export const POLICY_KINDS = ["submit_overdue", "retry_failed"] as const;
export type PolicyKind = (typeof POLICY_KINDS)[number];

function isPolicyKind(kind: string): kind is PolicyKind {
  return (POLICY_KINDS as readonly string[]).includes(kind);
}

// Same shape as billing/payments.ts — walk the cause chain for Postgres'
// unique_violation, which drizzle may wrap.
function isUniqueViolation(err: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const e = cur as { code?: string; cause?: unknown };
    if (e.code === "23505") return true;
    cur = e.cause;
  }
  return false;
}

async function policiesEnabled(firmId: string): Promise<boolean> {
  return (
    (await isFeatureEnabled(ACTIONS_FLAG_KEY, firmId)) &&
    (await isFeatureEnabled(POLICIES_FLAG_KEY, firmId))
  );
}

export interface ActionPolicyList {
  policies: ClerkActionPolicy[];
  // The grant AFFORDANCE gate only. Grants deliberately stay listed while
  // the flag is dark — they must remain visible, pausable and revocable
  // even when the engine that would run them is off.
  enabled: boolean;
}

export async function listActionPolicies(
  firmId: string,
  clientPartyId: string,
): Promise<ActionPolicyList> {
  const policies = await getDb()
    .select()
    .from(clerkActionPoliciesTable)
    .where(
      and(
        eq(clerkActionPoliciesTable.firmId, firmId),
        eq(clerkActionPoliciesTable.clientPartyId, clientPartyId),
        isNull(clerkActionPoliciesTable.revokedAt),
      ),
    )
    .orderBy(
      desc(clerkActionPoliciesTable.createdAt),
      desc(clerkActionPoliciesTable.id),
    );
  return { policies, enabled: await policiesEnabled(firmId) };
}

// Grant a standing approval. The route owns authz (invoice.submit + the
// party walls); this function owns the kind/cap guards, the double flag
// gate, the consent gate, live-uniqueness and the audit.
export async function grantActionPolicy(
  firmId: string,
  clientPartyId: string,
  principal: Principal,
  kind: string,
  maxTargetsPerRun?: number,
): Promise<ClerkActionPolicy> {
  if (!isPolicyKind(kind)) {
    throw new DomainError(
      "UNKNOWN_POLICY_KIND",
      "That action kind cannot be standing-approved",
      400,
    );
  }
  const cap = maxTargetsPerRun ?? MAX_ACTION_TARGETS;
  if (!Number.isInteger(cap) || cap < 1 || cap > MAX_ACTION_TARGETS) {
    throw new DomainError(
      "BAD_CAP",
      `maxTargetsPerRun must be between 1 and ${MAX_ACTION_TARGETS}`,
      400,
    );
  }
  if (!(await policiesEnabled(firmId))) {
    throw new DomainError(
      "POLICIES_DISABLED",
      "Standing approvals are not enabled for this firm",
      503,
    );
  }
  // A standing approval IS a submission authorization — consent gates the
  // grant exactly like it gates each run (CORE-03).
  if (!(await isPurposePermitted(clientPartyId, "compliance_submission"))) {
    throw new DomainError(
      "CONSENT_REQUIRED",
      "Supplier has not granted compliance (layer 1) consent",
      403,
    );
  }
  const [existing] = await getDb()
    .select({ id: clerkActionPoliciesTable.id })
    .from(clerkActionPoliciesTable)
    .where(
      and(
        eq(clerkActionPoliciesTable.firmId, firmId),
        eq(clerkActionPoliciesTable.clientPartyId, clientPartyId),
        eq(clerkActionPoliciesTable.kind, kind),
        isNull(clerkActionPoliciesTable.revokedAt),
      ),
    )
    .limit(1);
  if (existing) {
    throw new DomainError(
      "POLICY_EXISTS",
      "A standing approval for this action already exists — revoke it first",
      409,
    );
  }

  let row: ClerkActionPolicy;
  try {
    [row] = await getDb()
      .insert(clerkActionPoliciesTable)
      .values({
        firmId,
        clientPartyId,
        kind,
        maxTargetsPerRun: cap,
        grantedBy: principal.userId,
        grantedByRole: principal.role,
      })
      .returning();
  } catch (err) {
    // The partial unique index backstops a concurrent double-grant the
    // pre-check raced past.
    if (isUniqueViolation(err)) {
      throw new DomainError(
        "POLICY_EXISTS",
        "A standing approval for this action already exists — revoke it first",
        409,
      );
    }
    throw err;
  }

  await appendAudit({
    actorId: principal.userId,
    firmId,
    action: "clerk.action.policy_granted",
    entityType: "clerk_action_policy",
    entityId: row.id,
    after: { kind, maxTargetsPerRun: cap },
  });
  return row;
}

// Shared loader for the lifecycle mutations: the row by id (ambient RLS
// already walls the firm; the explicit firmId match is defense-in-depth),
// then the SEC-03 wall — a client_user may only touch its own party's
// grants.
async function loadPolicyForUpdate(
  firmId: string,
  id: string,
  principal: Principal,
): Promise<ClerkActionPolicy> {
  const [policy] = await getDb()
    .select()
    .from(clerkActionPoliciesTable)
    .where(
      and(
        eq(clerkActionPoliciesTable.id, id),
        eq(clerkActionPoliciesTable.firmId, firmId),
      ),
    )
    .limit(1);
  if (!policy) {
    throw new DomainError("NOT_FOUND", "Standing approval not found", 404);
  }
  assertClientPartyScope(principal, policy.clientPartyId);
  return policy;
}

export async function pauseActionPolicy(
  firmId: string,
  id: string,
  principal: Principal,
): Promise<ClerkActionPolicy> {
  const policy = await loadPolicyForUpdate(firmId, id, principal);
  if (policy.revokedAt) {
    throw new DomainError(
      "POLICY_REVOKED",
      "A revoked standing approval cannot be paused",
      409,
    );
  }
  // Idempotent: pausing a paused grant (including a tripwire pause) keeps
  // the existing pause and its reason.
  if (policy.pausedAt) return policy;
  const [row] = await getDb()
    .update(clerkActionPoliciesTable)
    .set({
      pausedAt: new Date(),
      pausedReason: "manual",
      pausedBy: principal.userId,
    })
    .where(
      and(
        eq(clerkActionPoliciesTable.id, id),
        isNull(clerkActionPoliciesTable.pausedAt),
        isNull(clerkActionPoliciesTable.revokedAt),
      ),
    )
    .returning();
  // A concurrent pause won the compare-and-set — same end state.
  if (!row) return loadPolicyForUpdate(firmId, id, principal);
  await appendAudit({
    actorId: principal.userId,
    firmId,
    action: "clerk.action.policy_paused",
    entityType: "clerk_action_policy",
    entityId: id,
    after: { kind: policy.kind, reason: "manual" },
  });
  return row;
}

export async function resumeActionPolicy(
  firmId: string,
  id: string,
  principal: Principal,
): Promise<ClerkActionPolicy> {
  const policy = await loadPolicyForUpdate(firmId, id, principal);
  if (policy.revokedAt) {
    throw new DomainError(
      "POLICY_REVOKED",
      "A revoked standing approval cannot be resumed — grant a new one",
      409,
    );
  }
  if (!policy.pausedAt) return policy;
  const [row] = await getDb()
    .update(clerkActionPoliciesTable)
    .set({ pausedAt: null, pausedReason: null, pausedBy: null })
    .where(
      and(
        eq(clerkActionPoliciesTable.id, id),
        isNull(clerkActionPoliciesTable.revokedAt),
      ),
    )
    .returning();
  if (!row) {
    throw new DomainError("NOT_FOUND", "Standing approval not found", 404);
  }
  await appendAudit({
    actorId: principal.userId,
    firmId,
    action: "clerk.action.policy_resumed",
    entityType: "clerk_action_policy",
    entityId: id,
    // A human resuming past a tripwire is a decision worth remembering —
    // record what the pause had said. (clearedReason comes from the load
    // above; a tripwire landing in the microsecond between load and update
    // could relabel it, but the clear itself is what the resumer intended
    // and the next run re-checks everything regardless.)
    after: { kind: policy.kind, clearedReason: policy.pausedReason },
  });
  return row;
}

export async function revokeActionPolicy(
  firmId: string,
  id: string,
  principal: Principal,
): Promise<ClerkActionPolicy> {
  const policy = await loadPolicyForUpdate(firmId, id, principal);
  // Idempotent: revoking twice is the same revocation.
  if (policy.revokedAt) return policy;
  const [row] = await getDb()
    .update(clerkActionPoliciesTable)
    .set({ revokedAt: new Date(), revokedBy: principal.userId })
    .where(
      and(
        eq(clerkActionPoliciesTable.id, id),
        isNull(clerkActionPoliciesTable.revokedAt),
      ),
    )
    .returning();
  if (!row) return loadPolicyForUpdate(firmId, id, principal);
  await appendAudit({
    actorId: principal.userId,
    firmId,
    action: "clerk.action.policy_revoked",
    entityType: "clerk_action_policy",
    entityId: id,
    after: { kind: policy.kind },
  });
  return row;
}

// ============ The daily sweep ============

// System actor for the tripwire audits (audit actor_id is free text — the
// watch sweeps' convention).
const SWEEP_ACTOR = "action-policy-sweep";

// Half or more of a run's targets failing outright means something is
// structurally wrong (an approval policy the grantor can't satisfy, a rail
// misconfiguration) — a human must look before the policy runs again.
function tooManyFailures(requested: number, failed: number): boolean {
  return requested > 0 && failed >= Math.ceil(requested / 2);
}

async function autoPause(
  policy: ClerkActionPolicy,
  reason:
    | "grantor_inactive"
    | "consent_missing"
    | "failed_targets"
    | "unknown_kind",
): Promise<boolean> {
  return runInBypassContext(async () => {
    const [row] = await getDb()
      .update(clerkActionPoliciesTable)
      .set({ pausedAt: new Date(), pausedReason: reason, pausedBy: null })
      .where(
        and(
          eq(clerkActionPoliciesTable.id, policy.id),
          isNull(clerkActionPoliciesTable.pausedAt),
          isNull(clerkActionPoliciesTable.revokedAt),
        ),
      )
      .returning({ id: clerkActionPoliciesTable.id });
    // A concurrent instance already paused it — one audit is enough.
    if (!row) return false;
    await appendAudit({
      actorId: SWEEP_ACTOR,
      firmId: policy.firmId,
      action: "clerk.action.policy_auto_paused",
      entityType: "clerk_action_policy",
      entityId: policy.id,
      after: { kind: policy.kind, reason },
    });
    return true;
  });
}

// A tripwire pause on an UNATTENDED feature must not wait for someone to
// open a dashboard (round-29: a paused submit_overdue policy is statutory
// exposure quietly accruing daily). One pointer-only signal to the GRANTOR
// — the human whose standing instruction just stopped — through the rail
// where they live:
//  - a client-granted policy notifies the client PARTY via the ordinary
//    alert fan-out (CORE-03 consent-gated, alert-preference channels, the
//    deadline-reminder rails; a consent_missing pause therefore sends
//    nothing — consent wins over notification, and the SME card still
//    shows the pause);
//  - a staff-granted policy notifies the grantor's own channels under the
//    staff-preference OPT-INS (the digest rail's exact posture: email only
//    with a verified, enabled address; push only when turned on) — and
//    ONLY while they still hold a firm_admin/firm_staff membership in this
//    firm (a departed or demoted grantor gets nothing; those pauses rely
//    on the Automation strip).
// Best-effort by design: sends run autocommit AFTER the pause committed,
// and any failure lands in the messages ledger (or is absorbed) — never in
// the sweep's control flow.
async function notifyAutoPause(policy: ClerkActionPolicy): Promise<void> {
  // PL-02 (round-29 review MAJOR): the platform-wide messaging kill switch
  // gates every sweep-side send — the digest/reminder/statement rails'
  // shared posture — and a dark rail means NO ledger rows and no provider
  // traffic. The pause itself (and its audit) has already committed; only
  // the signal goes quiet.
  if (!(await isFeatureEnabled("messaging_notifications", null))) return;
  const entityId = pointerEntityRef("pol", policy.id);
  if (policy.grantedByRole === "client_user") {
    const [prefs] = await getDb()
      .select()
      .from(alertPreferencesTable)
      .where(eq(alertPreferencesTable.clientPartyId, policy.clientPartyId));
    await fanOutAlert({
      prefs,
      clientPartyId: policy.clientPartyId,
      firmId: policy.firmId,
      templateKey: "automation_paused",
      entityType: "clerk_action_policy",
      entityId,
      smsDefaultWhenNoPrefs: false,
    });
    return;
  }
  // Digest-rail parity end to end (round-29 review): the grantor must still
  // be firm STAFF here (an operator/auditor membership is not a staff
  // channel; a client_user grantor took the party branch above), and both
  // channels honour the staff-preference opt-ins — email only under the
  // proven-ownership gate, push only when the member turned it on. The
  // Automation strip remains the guaranteed surface either way.
  const memberships = await getDb()
    .select({ role: membershipsTable.role })
    .from(membershipsTable)
    .where(
      and(
        eq(membershipsTable.userId, policy.grantedBy),
        eq(membershipsTable.firmId, policy.firmId),
      ),
    );
  const isStaff = memberships.some(
    (m) => m.role === "firm_admin" || m.role === "firm_staff",
  );
  if (!isStaff) return;
  const [prefs] = await getDb()
    .select()
    .from(staffNotificationPreferencesTable)
    .where(
      and(
        eq(staffNotificationPreferencesTable.userId, policy.grantedBy),
        eq(staffNotificationPreferencesTable.firmId, policy.firmId),
      ),
    );
  if (prefs?.emailEnabled && prefs.email && prefs.emailVerifiedAt) {
    try {
      await sendMessage({
        channel: "email",
        recipientRef: pointerEntityRef("usr", policy.grantedBy),
        recipientUserId: policy.grantedBy,
        templateKey: "automation_paused",
        entityType: "clerk_action_policy",
        entityId,
      });
    } catch {
      // Channel failures are recorded in the messages ledger.
    }
  }
  if (prefs?.pushEnabled) {
    try {
      await sendPushToUser({
        userId: policy.grantedBy,
        templateKey: "automation_paused",
        entityType: "clerk_action_policy",
        entityId,
      });
    } catch {
      // Push failures are likewise recorded by the push module.
    }
  }
}

// autoPause + the grantor signal, in that order: the pause is the durable
// state change (compare-and-set, audited), the notification is best-effort
// on top — only the CAS winner sends, so a concurrent instance can never
// double-notify, and a notification failure never fails the sweep.
async function autoPauseAndNotify(
  policy: ClerkActionPolicy,
  reason: Parameters<typeof autoPause>[1],
): Promise<boolean> {
  const won = await autoPause(policy, reason);
  if (won) {
    try {
      await notifyAutoPause(policy);
    } catch (err) {
      console.error(
        `action-policy sweep: pause notification for ${policy.id} failed:`,
        err,
      );
    }
  }
  return won;
}

// The grantor's CURRENT standing: a membership in this firm whose role
// still carries invoice.submit — and for a client_user, pinned to this very
// party (SEC-03: a client grantor automating a sibling client is exactly
// the wall this platform never lets RLS alone hold). Returns the role to
// reconstruct the principal with, or null when the grant must pause.
async function grantorRole(
  policy: ClerkActionPolicy,
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

type PolicyRunOutcome =
  | "ran"
  | "ran_then_paused"
  | "auto_paused"
  | "skipped_dark"
  | "skipped_empty"
  | "skipped_raced";

async function runOnePolicy(
  policy: ClerkActionPolicy,
  today: string,
): Promise<PolicyRunOutcome> {
  // Kill switches beat grants — and a dark flag must NOT consume the day:
  // flipping it back on mid-morning lets today's batch still run.
  if (!(await policiesEnabled(policy.firmId))) return "skipped_dark";

  // The kind column is open text (catalogue growth), but this sweep only
  // ever runs the automatable kinds. A row outside POLICY_KINDS — an ops
  // fix-up, a future backfill bug — must fail CLOSED here (round-28 review
  // M2): falling through proposalForKind would send draft_chasers to the
  // chaser builder and burn unattended model calls on drafts nobody can
  // ever read. (Guarded via a local: TS property narrowing does not
  // survive the awaits below.)
  const kind = policy.kind;
  if (!isPolicyKind(kind)) {
    return (await autoPauseAndNotify(policy, "unknown_kind"))
      ? "auto_paused"
      : "skipped_raced";
  }

  const role = await grantorRole(policy);
  if (!role) {
    // autoPause reports whether THIS instance's compare-and-set won; a
    // loss means a concurrent instance (or a human pause) got there first
    // — same end state, but only the winner counts it (review NIT).
    return (await autoPauseAndNotify(policy, "grantor_inactive"))
      ? "auto_paused"
      : "skipped_raced";
  }

  // Consent, re-checked per run under the firm's own RLS context exactly
  // as the execute path reads it (executeAction re-checks it again inside
  // Stage A — this earlier check exists to PAUSE the policy with a legible
  // reason instead of failing the run).
  const consented = await runRequestContext(
    { bypass: false, firmId: policy.firmId },
    () => isPurposePermitted(policy.clientPartyId, "compliance_submission"),
  );
  if (!consented) {
    return (await autoPauseAndNotify(policy, "consent_missing"))
      ? "auto_paused"
      : "skipped_raced";
  }

  // Assemble from the live proposal builders under the firm's context —
  // the same targets, same ordering (oldest first), same caps the card
  // would show a human.
  const proposal = await runRequestContext(
    { bypass: false, firmId: policy.firmId },
    () => proposalForKind(kind, policy.firmId, policy.clientPartyId),
  );
  const ids = (proposal?.targets ?? [])
    .slice(0, policy.maxTargetsPerRun)
    .map((t) => t.invoiceId);
  // Nothing to do — leave the day unclaimed so the hourly pass keeps
  // watching (the first non-empty batch of the day runs).
  if (ids.length === 0) return "skipped_empty";

  // Claim the day (compare-and-set) BEFORE executing: across instances at
  // most one claim succeeds, so the batch can never double-run. A crash
  // after the claim costs at most today's run — the safe direction for an
  // autopilot.
  const claimed = await runInBypassContext(() =>
    getDb()
      .update(clerkActionPoliciesTable)
      .set({ lastRunDay: today, lastRunAt: new Date() })
      .where(
        and(
          eq(clerkActionPoliciesTable.id, policy.id),
          isNull(clerkActionPoliciesTable.revokedAt),
          isNull(clerkActionPoliciesTable.pausedAt),
          or(
            isNull(clerkActionPoliciesTable.lastRunDay),
            ne(clerkActionPoliciesTable.lastRunDay, today),
          ),
        ),
      )
      .returning({ id: clerkActionPoliciesTable.id }),
  );
  // Another instance won the day's compare-and-set — same end state.
  if (claimed.length === 0) return "skipped_raced";

  // The grantor, as they stand TODAY (current role from the membership
  // re-check). executeAction owns everything from here — flag, consent,
  // per-target re-validation, the decision row (policyId set, decidedBy =
  // the grantor) and the batch audit — committing per target exactly like
  // a hand-approved batch.
  const principal: Principal = {
    userId: policy.grantedBy,
    role,
    firmId: policy.firmId,
    clientPartyId: role === "client_user" ? policy.clientPartyId : null,
    buyerPartyId: null,
  };
  const { decision } = await executeAction(
    policy.firmId,
    policy.clientPartyId,
    policy.grantedBy,
    kind,
    ids,
    principal,
    { policyId: policy.id },
  );

  if (tooManyFailures(decision.requestedCount, decision.failedCount)) {
    return (await autoPauseAndNotify(policy, "failed_targets"))
      ? "ran_then_paused"
      : "ran";
  }
  return "ran";
}

export interface ActionPolicySweepResult {
  policiesDue: number;
  policiesRun: number;
  policiesAutoPaused: number;
}

// One pass: every live, unpaused policy that has not yet claimed today
// (Lagos calendar). Per-policy failures are isolated — one broken firm
// must never stall the rest of the fleet.
export async function runActionPolicySweep(): Promise<ActionPolicySweepResult> {
  // Computed once per pass: a pass straddling Lagos midnight can claim the
  // OLD date at 00:01 and the policy then legitimately runs again under the
  // new date an hour later — each Lagos day still claims at most once,
  // which is the invariant that matters.
  const today = lagosDateString(new Date());
  const due = await runInBypassContext(() =>
    getDb()
      .select()
      .from(clerkActionPoliciesTable)
      .where(
        and(
          isNull(clerkActionPoliciesTable.revokedAt),
          isNull(clerkActionPoliciesTable.pausedAt),
          or(
            isNull(clerkActionPoliciesTable.lastRunDay),
            ne(clerkActionPoliciesTable.lastRunDay, today),
          ),
        ),
      )
      .orderBy(
        clerkActionPoliciesTable.createdAt,
        clerkActionPoliciesTable.id,
      ),
  );

  let policiesRun = 0;
  let policiesAutoPaused = 0;
  for (const policy of due) {
    try {
      const outcome = await runOnePolicy(policy, today);
      if (outcome === "ran" || outcome === "ran_then_paused") policiesRun++;
      if (outcome === "auto_paused" || outcome === "ran_then_paused") {
        policiesAutoPaused++;
      }
    } catch (err) {
      console.error(
        `action-policy sweep: policy ${policy.id} (${policy.kind}) failed:`,
        err,
      );
    }
  }
  return { policiesDue: due.length, policiesRun, policiesAutoPaused };
}

// The sweep loop ticks every minute; day-granularity work needs at most an
// hourly look (and the CAS makes even that idempotent).
registerSweep(atMostHourly(runActionPolicySweep));
