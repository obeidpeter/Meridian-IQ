import { and, desc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  runRequestContext,
  alertPreferencesTable,
  clerkActionDecisionsTable,
  clerkActionPoliciesTable,
  engagementsTable,
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
  AUTO_RETRY_ATTEMPT_CAP,
  MAX_ACTION_TARGETS,
  executeAction,
  proposalForKind,
} from "./actions";
import { decisionRailStanding } from "./action-effectiveness";
import { registerSweep } from "../pipeline/pipeline";
import { alertOnceViaAuditLedger, atMostHourly } from "./watch-shared";
import {
  ROLE_CAPABILITIES,
  assertClientPartyScope,
  type Principal,
} from "../auth/rbac";
import { logger } from "../../lib/logger";
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
//    consent_missing, engagement_closed (round 30: the firm↔client
//    relationship went dormant — no open/in_progress engagement),
//    failed_targets (half or more of a run's targets failing at DECISION
//    time), rail_rejections (round 30: half or more of the PREVIOUS run's
//    submitted targets are back in 'failed' — submitInvoice succeeds at
//    enqueue, so only a later re-read sees the rails' verdict), and
//    run_error (round 30: the run itself threw — fail closed, never
//    silently retry tomorrow). Pause vs revoke is deliberate: pause keeps
//    the grant and stops the engine; revoke is permanent evidence — the row
//    survives, a partial unique index keeps one LIVE grant per
//    (firm, client, kind), and re-automating takes a fresh grant.
//  - Retry assembly under a policy additionally drops invoices with
//    AUTO_RETRY_ATTEMPT_CAP+ submission attempts (round 30) — the autopilot
//    gives up on rail-hammered paper; the HUMAN proposal keeps showing it.
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

// Live engagement = open/in_progress — the client-statement sweep's exact
// enumeration of "clients the firm actively serves" (completed/archived is a
// closed book of work). Deliberately a LOCAL helper: rbac's firmEngagesParty
// counts ANY engagement, archived included, because retention-era reads need
// that — this stricter wall must not replace it. Reads via the ambient
// getDb(): the grant path runs in the caller's request context (engagements
// are firm-keyed RLS), the sweep wraps it in its own firm-bound context.
async function hasLiveEngagement(
  firmId: string,
  clientPartyId: string,
): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: engagementsTable.id })
    .from(engagementsTable)
    .where(
      and(
        eq(engagementsTable.firmId, firmId),
        eq(engagementsTable.clientPartyId, clientPartyId),
        inArray(engagementsTable.status, ["open", "in_progress"]),
      ),
    )
    .limit(1);
  return Boolean(row);
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
  // Offboard wall (round-30 review): a standing approval automates an ACTIVE
  // firm↔client relationship. The route's assertPartyAccess accepts ANY
  // engagement — archived included, so retention-era reads keep working —
  // but a GRANT needs a live one (open/in_progress): a firm must not switch
  // an autopilot on for a client it has already wound down. The sweep
  // re-checks this per run (engagement_closed tripwire below) for the
  // engagement-archived-AFTER-grant path.
  if (!(await hasLiveEngagement(firmId, clientPartyId))) {
    throw new DomainError(
      "NO_LIVE_ENGAGEMENT",
      "The firm has no open engagement with this client — a standing approval needs a live relationship",
      409,
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
  // Round-30 review: the OTHER side of the relationship learns a standing
  // approval now exists (the grantor already knows — they clicked). Best-
  // effort like every notification in this module: a send failure must
  // never fail the grant (autoPauseAndNotify's absorb, mirrored).
  try {
    await notifyPolicyGranted(row);
  } catch (err) {
    console.error(
      `action-policy grant: notification for ${row.id} failed:`,
      err,
    );
  }
  return row;
}

// The grant signal — notifyAutoPause's mirror image, addressed to the side
// that did NOT click (a client whose accountant switches an autopilot on, or
// a firm whose client does, must not discover it from the decision ledger).
// Same rails, same gates as the pause signal:
//  - the platform messaging kill switch first (PL-02: a dark rail means NO
//    ledger rows and no provider traffic);
//  - a STAFF-granted policy notifies the client PARTY via the ordinary alert
//    fan-out — consent-gated INSIDE fanOutAlert (CORE-03: no live layer-1
//    grant, no message), SMS default off with no prefs row, pointer-only
//    entity (SEC-12);
//  - a CLIENT-granted policy notifies the firm's staff/admins under the
//    staff-preference OPT-INS (email only verified+enabled, push only when
//    turned on) — notifyAutoPause's staff resolution, widened from the one
//    grantor to every staff member (the firm side has no single owner).
// Exported ONLY for the consent-gate test (a policy replayed after consent
// lapsed must send nothing); production's one caller is grantActionPolicy.
export async function notifyPolicyGranted(
  policy: ClerkActionPolicy,
): Promise<void> {
  if (!(await isFeatureEnabled("messaging_notifications", null))) return;
  const entityId = pointerEntityRef("pol", policy.id);
  if (policy.grantedByRole !== "client_user") {
    // PRIVILEGE: explicit app.bypass for the prefs read — alert_preferences
    // is party-keyed RLS (0013) and this helper also runs from test/raw
    // callers with no principal; the query is pinned by explicit WHERE to
    // the policy's own party, nothing broader. The sends ride the caller's
    // ambient posture (the compliance-pack notify precedent).
    const [prefs] = await runInBypassContext(() =>
      getDb()
        .select()
        .from(alertPreferencesTable)
        .where(eq(alertPreferencesTable.clientPartyId, policy.clientPartyId)),
    );
    await fanOutAlert({
      prefs,
      clientPartyId: policy.clientPartyId,
      firmId: policy.firmId,
      templateKey: "automation_granted",
      entityType: "clerk_action_policy",
      entityId,
      // Deadline-reminder default: with no prefs row, SMS stays off.
      smsDefaultWhenNoPrefs: false,
    });
    return;
  }
  // PRIVILEGE: explicit app.bypass for the recipient resolution — the grant
  // path's ambient context is the CLIENT grantor's, which cannot read
  // sibling staff rows (staff prefs are firm-keyed RLS 0019, memberships are
  // pre-context tables). Both queries are pinned by explicit WHERE to the
  // policy's own firm, so the privilege reaches exactly the recipients the
  // signal is for.
  const staffPrefs = await runInBypassContext(async () => {
    const members = await getDb()
      .select({ userId: membershipsTable.userId })
      .from(membershipsTable)
      .where(
        and(
          eq(membershipsTable.firmId, policy.firmId),
          inArray(membershipsTable.role, ["firm_admin", "firm_staff"]),
        ),
      );
    const ids = [...new Set(members.map((m) => m.userId))];
    if (ids.length === 0) return [];
    return getDb()
      .select()
      .from(staffNotificationPreferencesTable)
      .where(
        and(
          eq(staffNotificationPreferencesTable.firmId, policy.firmId),
          inArray(staffNotificationPreferencesTable.userId, ids),
        ),
      );
  });
  for (const prefs of staffPrefs) {
    if (prefs.emailEnabled && prefs.email && prefs.emailVerifiedAt) {
      try {
        await sendMessage({
          channel: "email",
          recipientRef: pointerEntityRef("usr", prefs.userId),
          recipientUserId: prefs.userId,
          templateKey: "automation_granted",
          entityType: "clerk_action_policy",
          entityId,
        });
      } catch {
        // Channel failures are recorded in the messages ledger.
      }
    }
    if (prefs.pushEnabled) {
      try {
        await sendPushToUser({
          userId: prefs.userId,
          templateKey: "automation_granted",
          entityType: "clerk_action_policy",
          entityId,
        });
      } catch {
        // Push failures are likewise recorded by the push module.
      }
    }
  }
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
// Exported (round 32): the plan-run processor halts on the same half-rule —
// one spelling of "this batch went badly" across every automation surface.
export function tooManyFailures(requested: number, failed: number): boolean {
  return requested > 0 && failed >= Math.ceil(requested / 2);
}

async function autoPause(
  policy: ClerkActionPolicy,
  // pausedReason is free text at the contract layer; this union is the
  // module's own closed catalogue of tripwires (round 30 added the last
  // three — see the header).
  reason:
    | "grantor_inactive"
    | "consent_missing"
    | "failed_targets"
    | "unknown_kind"
    | "engagement_closed"
    | "rail_rejections"
    | "run_error",
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
    // PRIVILEGE (round-30 review): this read runs under an EXPLICIT bypass
    // context — before, it hit the raw pool only because the caller's bypass
    // transaction had already closed, i.e. BYPASSRLS by omission. The sweep
    // holds no request principal and alert_preferences is party-keyed RLS
    // (0013), so app.bypass is the honest privilege level; the query is
    // pinned by explicit WHERE to the policy's own party, nothing broader.
    // The SENDS stay outside the context on purpose: autocommit ledger
    // writes, and no transaction may span provider I/O (the statement-
    // delivery rule).
    const [prefs] = await runInBypassContext(() =>
      getDb()
        .select()
        .from(alertPreferencesTable)
        .where(eq(alertPreferencesTable.clientPartyId, policy.clientPartyId)),
    );
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
  // PRIVILEGE (round-30 review): same explicit app.bypass as the party
  // branch — memberships (cross-firm, pre-context) and staff prefs
  // (firm-keyed RLS 0019) are reads no principal backs here, both pinned by
  // explicit WHERE to the policy's own grantor and firm. Sends again run
  // OUTSIDE the context (autocommit; provider I/O never inside a tx).
  const prefs = await runInBypassContext(async () => {
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
    if (!isStaff) return null;
    const [row] = await getDb()
      .select()
      .from(staffNotificationPreferencesTable)
      .where(
        and(
          eq(staffNotificationPreferencesTable.userId, policy.grantedBy),
          eq(staffNotificationPreferencesTable.firmId, policy.firmId),
        ),
      );
    return row ?? null;
  });
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

  // Offboard tripwire (round-30 review): the grant wall refuses without a
  // live (open/in_progress) engagement, and this re-check catches the
  // engagement archived AFTER the grant — a standing approval must not
  // outlive the relationship it automates. (A full party offboard already
  // revokes the grant in offboard.ts; this covers the status-only paths
  // that delete nothing.) Firm-bound context: engagements are firm-keyed
  // RLS and the policy names its own firm.
  const engaged = await runRequestContext(
    { bypass: false, firmId: policy.firmId },
    () => hasLiveEngagement(policy.firmId, policy.clientPartyId),
  );
  if (!engaged) {
    return (await autoPauseAndNotify(policy, "engagement_closed"))
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

  // Rail-rejection tripwire (round-30 review, mechanism 2): submitInvoice
  // succeeds at ENQUEUE time, so a decision full of "submitted" outcomes can
  // still be a batch the rails later rejected wholesale — and the
  // tooManyFailures check after executeAction only ever sees DECISION-time
  // failures. Re-read the policy's PREVIOUS run through the effectiveness
  // report's own helper (decisionRailStanding — one SQL spelling of
  // nowFailedAgain, never a second): half or more of its submitted targets
  // back in 'failed' means the autopilot is feeding rejected paper to the
  // rails, so pause INSTEAD of running today (same half rule as the
  // decision-time tripwire). Firm-bound read, like the assembly below.
  const previous = await runRequestContext(
    { bypass: false, firmId: policy.firmId },
    async () => {
      const [prev] = await getDb()
        .select({ id: clerkActionDecisionsTable.id })
        .from(clerkActionDecisionsTable)
        .where(eq(clerkActionDecisionsTable.policyId, policy.id))
        .orderBy(
          desc(clerkActionDecisionsTable.createdAt),
          desc(clerkActionDecisionsTable.id),
        )
        .limit(1);
      return prev ? decisionRailStanding(prev.id) : null;
    },
  );
  if (previous && tooManyFailures(previous.submitted, previous.nowFailedAgain)) {
    return (await autoPauseAndNotify(policy, "rail_rejections"))
      ? "auto_paused"
      : "skipped_raced";
  }

  // Assemble from the live proposal builders under the firm's context —
  // the same targets, same ordering (oldest first), same caps the card
  // would show a human. The one automation-only narrowing: the attempt cap
  // (mechanism 1 of the rail-rejection fix) drops retry candidates the
  // rails have already bounced AUTO_RETRY_ATTEMPT_CAP times — the human
  // proposal keeps offering them, a person may still choose.
  const proposal = await runRequestContext(
    { bypass: false, firmId: policy.firmId },
    () =>
      proposalForKind(kind, policy.firmId, policy.clientPartyId, {
        maxSubmissionAttempts: AUTO_RETRY_ATTEMPT_CAP,
      }),
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

// Fleet alert identity (round-30 review): a once-per-Lagos-day, durable
// operator signal that the sweep auto-paused SOMETHING — the append-only
// audit ledger is the cross-instance dedup key (health-watch's discipline).
// The payload carries COUNTS only (pointer-only, SEC-12): per-policy detail
// lives on each policy's own clerk.action.policy_auto_paused audit row.
export const ACTION_POLICY_AUTO_PAUSE_ALERT = "ops.action_policy.auto_paused";

const alertAutoPaused = alertOnceViaAuditLedger({
  action: ACTION_POLICY_AUTO_PAUSE_ALERT,
  entityType: "action_policy_sweep",
  actorId: SWEEP_ACTOR,
});

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
      // Fail CLOSED (round-30 review): the day may already be claimed, so
      // "log and leave live" meant a policy whose run THROWS — a bug, a
      // dependency down mid-run — would silently retry every day forever,
      // exactly the unattended-repeat class the tripwires exist for. Pause
      // it like any other tripwire (CAS + audit + grantor signal); the
      // pause's own failure is absorbed so one broken policy still cannot
      // stall the rest of the fleet.
      try {
        if (await autoPauseAndNotify(policy, "run_error")) {
          policiesAutoPaused++;
        }
      } catch (pauseErr) {
        console.error(
          `action-policy sweep: run_error pause for ${policy.id} failed:`,
          pauseErr,
        );
      }
    }
  }

  const result: ActionPolicySweepResult = {
    policiesDue: due.length,
    policiesRun,
    policiesAutoPaused,
  };
  // Fleet visibility (round-30 review): these counters were computed and
  // discarded — no operator could see the autopilot fleet move. One info
  // line per pass, and NEW auto-pauses additionally raise the durable
  // once-per-Lagos-day audit alert declared above (counts only; best-effort
  // — a failed alert never fails the sweep, the per-policy audits already
  // landed). Bypass context: the ledger dedup read + append are ops-level
  // work with no principal, same as the health-watch sweep's posture.
  logger.info(result, "action-policy sweep: pass complete");
  if (policiesAutoPaused > 0) {
    try {
      await runInBypassContext(() =>
        alertAutoPaused(
          `auto-paused:${today}`,
          {
            ...result,
            day: today,
            reason:
              "The action-policy sweep auto-paused standing approvals: tripwires fired and the affected automations are stopped until a human reviews and resumes them.",
          },
          "Standing approvals were auto-paused by the action-policy sweep; review the policy audit trail and the firms' Automation strips.",
        ),
      );
    } catch (err) {
      console.error("action-policy sweep: auto-pause alert failed:", err);
    }
  }
  return result;
}

// The sweep loop ticks every minute; day-granularity work needs at most an
// hourly look (and the CAS makes even that idempotent).
registerSweep(atMostHourly(runActionPolicySweep));
