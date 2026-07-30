import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  getDb,
  auditEventsTable,
  clerkActionDecisionsTable,
  clerkActionPoliciesTable,
  engagementsTable,
  featureFlagsTable,
  firmsTable,
  invoicesTable,
  membershipsTable,
  messagesTable,
  partiesTable,
  staffNotificationPreferencesTable,
  usersTable,
} from "@workspace/db";
import { createDraft } from "../invoice/service.ts";
import { setFirmOverride } from "../flags/flags.ts";
import { recordConsent } from "../consent/consent.ts";
import type { Principal } from "../auth/rbac.ts";
import { ACTIONS_FLAG_KEY, MAX_ACTION_TARGETS } from "./actions.ts";
import {
  POLICIES_FLAG_KEY,
  POLICY_KINDS,
  grantActionPolicy,
  listActionPolicies,
  pauseActionPolicy,
  resumeActionPolicy,
  revokeActionPolicy,
  runActionPolicySweep,
} from "./action-policies.ts";
import { runDataIntent } from "./data-intents/index.ts";
import { isDomainError } from "../../test-helpers/assertions.ts";
import { daysAgo, makeRunSalt } from "../../test-helpers/fixtures.ts";
import {
  clientPrincipal,
  firmPrincipal as makeFirmPrincipal,
} from "../../test-helpers/principals.ts";
import { grantComplianceConsent } from "../../test-helpers/seeders.ts";
import { lagosDateString } from "../../lib/lagos-time.ts";

// Standing approvals (round 28). Pinned invariants:
//  - doubly fail-closed: granting refuses unless BOTH clerk_actions and
//    clerk_action_policies are lit, and a dark flag makes the sweep skip
//    WITHOUT consuming the policy's day;
//  - the grant lifecycle is honest: one live grant per (client, kind),
//    revocation is permanent evidence (re-granting starts a new row), pause
//    is reversible whether a human or a tripwire set it;
//  - the sweep re-validates the WORLD per run: a grantor whose membership
//    lapsed pauses the policy (grantor_inactive), lapsed consent pauses it
//    (consent_missing), a majority-failed run pauses it (failed_targets) —
//    each audited with the system actor, never silently;
//  - a run claims the Lagos day BEFORE executing (at most once per day) but
//    an empty assembly leaves the day UNCLAIMED (the hourly pass keeps
//    watching);
//  - what runs is executeAction itself: the decision row carries policyId +
//    decidedBy = the grantor, targets re-checked per invoice as ever.
// Fixtures are salted — submitted invoices persist in the shared DB.

const SALT = makeRunSalt();

const firmId = randomUUID();
const foreignFirmId = randomUUID();
const grantorId = randomUUID(); // has a firm_admin membership
const ghostId = randomUUID(); // NO membership row — the departed grantor
const clientGrantorId = randomUUID(); // client_user membership, pinned to clientA

const LINE = {
  description: "Goods",
  quantity: "1",
  unitPrice: "1000",
  vatRate: "0.075",
};

const grantor: Principal = makeFirmPrincipal(firmId, { userId: grantorId });

// One engaged+consented supplier party per scenario so sweeps never bleed
// into each other's paper.
async function seedSupplier(tag: string): Promise<string> {
  const id = randomUUID();
  const db = getDb();
  await db.insert(partiesTable).values({
    id,
    type: "client_business",
    legalName: `Policy ${tag} ${SALT}`,
    tin: `30${String(Math.abs(hash(tag + SALT)) % 1_000_000).padStart(6, "0")}-0001`,
    street: "1 Marina Rd",
    city: "Lagos",
  });
  await db.insert(engagementsTable).values({
    firmId,
    clientPartyId: id,
    type: "readiness_assessment",
    title: `policy ${tag}`,
  });
  await grantComplianceConsent(id, grantorId);
  return id;
}

function hash(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
}

let buyer: string;
let buyerNoTin: string;
let n = 0;
function draftFor(
  supplierPartyId: string,
  issueDate: string,
  buyerPartyId = buyer,
): Promise<{ invoice: { id: string } }> {
  n += 1;
  return createDraft(
    {
      firmId,
      supplierPartyId,
      buyerPartyId,
      invoiceNumber: `POL-${SALT}-${n}`,
      issueDate,
      dueDate: null,
      lines: [LINE],
    },
    grantorId,
  );
}

async function policyRow(id: string) {
  const [row] = await getDb()
    .select()
    .from(clerkActionPoliciesTable)
    .where(eq(clerkActionPoliciesTable.id, id));
  return row;
}

async function lastAudit(action: string) {
  const [row] = await getDb()
    .select()
    .from(auditEventsTable)
    .where(eq(auditEventsTable.action, action))
    .orderBy(desc(auditEventsTable.seq))
    .limit(1);
  return row;
}

let clientA: string; // the lifecycle + walls party (no invoices ever)

// The pause signals ride the platform-wide messaging rail, which every
// sweep-side sender gates on (PL-02). This suite lights it to observe the
// sends and puts it back exactly as found (delete when it did not
// pre-exist) — the health-watch/digest suites' save/restore idiom.
const MESSAGING_FLAG = "messaging_notifications";
let messagingFlagWasEnabled: boolean | null = null;

before(async () => {
  const db = getDb();
  const [existingMessaging] = await db
    .select()
    .from(featureFlagsTable)
    .where(eq(featureFlagsTable.key, MESSAGING_FLAG))
    .limit(1);
  messagingFlagWasEnabled = existingMessaging
    ? existingMessaging.enabled
    : null;
  await db
    .insert(featureFlagsTable)
    .values({ key: MESSAGING_FLAG, enabled: true, description: "test" })
    .onConflictDoUpdate({
      target: featureFlagsTable.key,
      set: { enabled: true },
    });
  // Both action flag rows exactly as boot seeding ships them: DARK. Tests
  // opt the firm in via per-firm overrides only.
  await db
    .insert(featureFlagsTable)
    .values([
      {
        key: ACTIONS_FLAG_KEY,
        enabled: false,
        releaseTag: "R3",
        description: "Clerk proposed actions (test seed)",
      },
      {
        key: POLICIES_FLAG_KEY,
        enabled: false,
        releaseTag: "R3",
        description: "Clerk standing approvals (test seed)",
      },
    ])
    .onConflictDoNothing({ target: featureFlagsTable.key });
  await db.insert(usersTable).values([
    { id: grantorId, email: `policy-${SALT}@test.local` },
    { id: ghostId, email: `policy-ghost-${SALT}@test.local` },
    { id: clientGrantorId, email: `policy-client-${SALT}@test.local` },
  ]);
  await db.insert(firmsTable).values([
    { id: firmId, name: `Policy Firm ${SALT}` },
    { id: foreignFirmId, name: `Policy Foreign ${SALT}` },
  ]);
  buyer = randomUUID();
  buyerNoTin = randomUUID();
  await db.insert(partiesTable).values([
    {
      id: buyer,
      type: "buyer",
      legalName: `Policy Buyer ${SALT}`,
      tin: "20000000-0002",
      street: "3 Broad St",
      city: "Lagos",
    },
    {
      // No TIN/street/city: canonical validation fails — the deterministic
      // "invalid target" fixture for the failed_targets tripwire.
      id: buyerNoTin,
      type: "buyer",
      legalName: `Policy Incomplete Buyer ${SALT}`,
    },
  ]);
  clientA = await seedSupplier("A");
  await db.insert(membershipsTable).values([
    { userId: grantorId, firmId, role: "firm_admin" },
    // Pinned to clientA — the SEC-03 mismatch test grants for a DIFFERENT
    // party under this user.
    { userId: clientGrantorId, firmId, role: "client_user", clientPartyId: clientA },
  ]);
});

// The shared DB persists across runs (salted fixtures by design) but a LIVE
// policy is a standing instruction to a GLOBAL sweep: tomorrow this run's
// claimed policies would be due again — with leftover paper — for whichever
// suite calls runActionPolicySweep() first (round-28 review M3). Revoke
// everything this suite granted, even when a test failed mid-way.
after(async () => {
  await getDb()
    .update(clerkActionPoliciesTable)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(clerkActionPoliciesTable.firmId, firmId),
        isNull(clerkActionPoliciesTable.revokedAt),
      ),
    );
  // Put the messaging flag back exactly as found.
  const db = getDb();
  if (messagingFlagWasEnabled === null) {
    await db
      .delete(featureFlagsTable)
      .where(eq(featureFlagsTable.key, MESSAGING_FLAG));
  } else {
    await db
      .update(featureFlagsTable)
      .set({ enabled: messagingFlagWasEnabled })
      .where(eq(featureFlagsTable.key, MESSAGING_FLAG));
  }
});

test("dark flags: granting refuses, the list says so, and clerk_actions alone is not enough", async () => {
  assert.deepEqual(await listActionPolicies(firmId, clientA), {
    policies: [],
    enabled: false,
  });
  await assert.rejects(
    grantActionPolicy(firmId, clientA, grantor, "submit_overdue"),
    isDomainError("POLICIES_DISABLED", 503),
  );
  // The layering is real: the base flag alone leaves policies dark.
  await setFirmOverride(ACTIONS_FLAG_KEY, firmId, true);
  await assert.rejects(
    grantActionPolicy(firmId, clientA, grantor, "submit_overdue"),
    isDomainError("POLICIES_DISABLED", 503),
  );
  await setFirmOverride(POLICIES_FLAG_KEY, firmId, true);
  assert.equal((await listActionPolicies(firmId, clientA)).enabled, true);
});

test("the automatable catalogue is the submit kinds only, and the cap is bounded", async () => {
  assert.deepEqual([...POLICY_KINDS], ["submit_overdue", "retry_failed"]);
  await assert.rejects(
    grantActionPolicy(firmId, clientA, grantor, "draft_chasers"),
    isDomainError("UNKNOWN_POLICY_KIND", 400),
  );
  await assert.rejects(
    grantActionPolicy(firmId, clientA, grantor, "send_everything"),
    isDomainError("UNKNOWN_POLICY_KIND", 400),
  );
  for (const bad of [0, MAX_ACTION_TARGETS + 1, 2.5]) {
    await assert.rejects(
      grantActionPolicy(firmId, clientA, grantor, "submit_overdue", bad),
      isDomainError("BAD_CAP", 400),
    );
  }
});

test("consent gates the grant itself", async () => {
  const unconsented = randomUUID();
  const db = getDb();
  await db.insert(partiesTable).values({
    id: unconsented,
    type: "client_business",
    legalName: `Policy Unconsented ${SALT}`,
    tin: "30000000-0009",
    street: "2 Marina Rd",
    city: "Lagos",
  });
  await db.insert(engagementsTable).values({
    firmId,
    clientPartyId: unconsented,
    type: "readiness_assessment",
    title: "policy unconsented",
  });
  await assert.rejects(
    grantActionPolicy(firmId, unconsented, grantor, "submit_overdue"),
    isDomainError("CONSENT_REQUIRED", 403),
  );
});

test("grant lifecycle: grant, duplicate-refuse, pause, resume, revoke, re-grant — audited at every step", async () => {
  const policy = await grantActionPolicy(
    firmId,
    clientA,
    grantor,
    "submit_overdue",
  );
  assert.equal(policy.kind, "submit_overdue");
  assert.equal(policy.maxTargetsPerRun, MAX_ACTION_TARGETS, "cap defaults to the batch maximum");
  assert.equal(policy.grantedBy, grantorId);
  assert.equal(policy.grantedByRole, "firm_admin");
  assert.equal(policy.pausedAt, null);
  assert.equal(policy.lastRunDay, null);
  const granted = await lastAudit("clerk.action.policy_granted");
  assert.equal(granted?.entityId, policy.id);

  // One live grant per (client, kind) — and the other kind is independent.
  await assert.rejects(
    grantActionPolicy(firmId, clientA, grantor, "submit_overdue", 5),
    isDomainError("POLICY_EXISTS", 409),
  );
  const retry = await grantActionPolicy(firmId, clientA, grantor, "retry_failed", 10);
  assert.equal(retry.maxTargetsPerRun, 10);
  assert.equal(
    (await listActionPolicies(firmId, clientA)).policies.length,
    2,
    "both live grants list",
  );

  // Pause is reversible and idempotent.
  const paused = await pauseActionPolicy(firmId, policy.id, grantor);
  assert.ok(paused.pausedAt);
  assert.equal(paused.pausedReason, "manual");
  assert.equal(paused.pausedBy, grantorId);
  const pausedAgain = await pauseActionPolicy(firmId, policy.id, grantor);
  assert.equal(
    pausedAgain.pausedAt?.getTime(),
    paused.pausedAt?.getTime(),
    "pausing a paused grant keeps the existing pause",
  );
  assert.equal((await lastAudit("clerk.action.policy_paused"))?.entityId, policy.id);

  const resumed = await resumeActionPolicy(firmId, policy.id, grantor);
  assert.equal(resumed.pausedAt, null);
  assert.equal(resumed.pausedReason, null);
  const resumeAudit = await lastAudit("clerk.action.policy_resumed");
  assert.equal(resumeAudit?.entityId, policy.id);
  assert.equal(
    (resumeAudit?.after as { clearedReason?: string | null })?.clearedReason,
    "manual",
    "the resume records what the pause had said",
  );

  // Revoke is permanent evidence: the row survives, resume refuses, a fresh
  // grant starts a NEW row.
  const revoked = await revokeActionPolicy(firmId, policy.id, grantor);
  assert.ok(revoked.revokedAt);
  assert.equal(revoked.revokedBy, grantorId);
  const revokedAgain = await revokeActionPolicy(firmId, policy.id, grantor);
  assert.equal(
    revokedAgain.revokedAt?.getTime(),
    revoked.revokedAt?.getTime(),
    "revoking twice is the same revocation",
  );
  await assert.rejects(
    resumeActionPolicy(firmId, policy.id, grantor),
    isDomainError("POLICY_REVOKED", 409),
  );
  await assert.rejects(
    pauseActionPolicy(firmId, policy.id, grantor),
    isDomainError("POLICY_REVOKED", 409),
  );
  assert.equal((await lastAudit("clerk.action.policy_revoked"))?.entityId, policy.id);

  const regrant = await grantActionPolicy(firmId, clientA, grantor, "submit_overdue", 7);
  assert.notEqual(regrant.id, policy.id, "a re-grant is a new artifact");
  const listed = await listActionPolicies(firmId, clientA);
  assert.ok(
    listed.policies.every((p) => p.revokedAt === null),
    "revoked grants are history, not listed",
  );

  // Clean up every live grant so later sweep tests own their world.
  for (const p of listed.policies) {
    await revokeActionPolicy(firmId, p.id, grantor);
  }
});

test("walls: a sibling client_user cannot touch the grant; a foreign firm cannot even see it", async () => {
  const policy = await grantActionPolicy(firmId, clientA, grantor, "submit_overdue");
  const sibling = clientPrincipal(firmId, randomUUID());
  await assert.rejects(
    pauseActionPolicy(firmId, policy.id, sibling),
    isDomainError("CROSS_CLIENT", 403),
  );
  await assert.rejects(
    revokeActionPolicy(firmId, policy.id, sibling),
    isDomainError("CROSS_CLIENT", 403),
  );
  // The module's own firm match (defense-in-depth under the route's RLS).
  await assert.rejects(
    pauseActionPolicy(foreignFirmId, policy.id, makeFirmPrincipal(foreignFirmId)),
    isDomainError("NOT_FOUND", 404),
  );
  await revokeActionPolicy(firmId, policy.id, grantor);
});

test("sweep happy path: assembles from the live builders, claims the day, executes as the grantor under the policy", async () => {
  const client = await seedSupplier("Sweep");
  const oldest = (await draftFor(client, daysAgo(30))).invoice.id;
  const newer = (await draftFor(client, daysAgo(20))).invoice.id;
  // Cap 1: the run must take the OLDEST target only — the cap is real.
  const policy = await grantActionPolicy(firmId, client, grantor, "submit_overdue", 1);

  const result = await runActionPolicySweep();
  assert.equal(result.policiesRun, 1);
  assert.equal(result.policiesAutoPaused, 0);

  const afterRow = await policyRow(policy.id);
  assert.equal(afterRow?.lastRunDay, lagosDateString(new Date()), "the day is claimed");
  assert.ok(afterRow?.lastRunAt, "the run is timestamped");
  assert.equal(afterRow?.pausedAt, null);

  const [decision] = await getDb()
    .select()
    .from(clerkActionDecisionsTable)
    .where(eq(clerkActionDecisionsTable.policyId, policy.id));
  assert.ok(decision, "the decision row names the policy");
  assert.equal(decision.decidedBy, grantorId, "decidedBy is the GRANTOR");
  assert.equal(decision.kind, "submit_overdue");
  assert.equal(decision.requestedCount, 1, "maxTargetsPerRun caps the batch");
  assert.equal(decision.executedCount, 1);
  assert.equal(decision.targets[0].invoiceId, oldest, "oldest first — the card's own ordering");

  const statusOf = async (id: string) =>
    (
      await getDb()
        .select({ status: invoicesTable.status })
        .from(invoicesTable)
        .where(eq(invoicesTable.id, id))
    )[0]!.status;
  assert.equal(await statusOf(oldest), "submitted", "the submission is REAL");
  assert.equal(await statusOf(newer), "draft", "beyond the cap, untouched");

  // The batch audit carries the policy pointer.
  const audit = await lastAudit("clerk.action.executed");
  assert.equal(
    (audit?.after as { policyId?: string })?.policyId,
    policy.id,
  );

  // Same day, second pass: the claim holds — THIS policy neither re-runs
  // nor writes a second decision (pinned on the policy's own rows, not the
  // sweep's global counters, which other due policies could legitimately
  // move — round-28 review M3).
  await runActionPolicySweep();
  const decisionsForPolicy = await getDb()
    .select({ id: clerkActionDecisionsTable.id })
    .from(clerkActionDecisionsTable)
    .where(eq(clerkActionDecisionsTable.policyId, policy.id));
  assert.equal(decisionsForPolicy.length, 1, "one decision for the day");
  assert.equal(await statusOf(newer), "draft", "no double-run");
});

test("a dark flag makes the sweep skip WITHOUT consuming the day", async () => {
  const client = await seedSupplier("Dark");
  await draftFor(client, daysAgo(25));
  const policy = await grantActionPolicy(firmId, client, grantor, "submit_overdue");
  await setFirmOverride(POLICIES_FLAG_KEY, firmId, false);

  const result = await runActionPolicySweep();
  assert.equal(result.policiesRun, 0);
  const afterRow = await policyRow(policy.id);
  assert.equal(afterRow?.lastRunDay, null, "the day is NOT claimed — flipping the flag back on lets today still run");
  assert.equal(afterRow?.pausedAt, null, "a dark flag is an ops state, not a policy state");

  await setFirmOverride(POLICIES_FLAG_KEY, firmId, true);
  const rerun = await runActionPolicySweep();
  assert.equal(rerun.policiesRun, 1, "the same policy runs once relit");
  assert.equal((await policyRow(policy.id))?.lastRunDay, lagosDateString(new Date()));
});

test("a departed grantor pauses the policy — grantor_inactive", async () => {
  const client = await seedSupplier("Ghost");
  await draftFor(client, daysAgo(25));
  // Direct insert: the ghost never had a membership, so the GRANT path
  // would already have been authz-refused at the route — the sweep must
  // still catch the row (the grantor may leave AFTER granting).
  const [policy] = await getDb()
    .insert(clerkActionPoliciesTable)
    .values({
      firmId,
      clientPartyId: client,
      kind: "submit_overdue",
      maxTargetsPerRun: 50,
      grantedBy: ghostId,
      grantedByRole: "firm_admin",
    })
    .returning();

  const result = await runActionPolicySweep();
  assert.equal(result.policiesAutoPaused, 1);
  const afterRow = await policyRow(policy.id);
  assert.ok(afterRow?.pausedAt);
  assert.equal(afterRow?.pausedReason, "grantor_inactive");
  assert.equal(afterRow?.pausedBy, null, "the system paused it, not a person");
  assert.equal(afterRow?.lastRunDay, null, "a pause is not a run");
  const audit = await lastAudit("clerk.action.policy_auto_paused");
  assert.equal(audit?.entityId, policy.id);
  assert.equal(audit?.actorId, "action-policy-sweep");
  assert.equal((audit?.after as { reason?: string })?.reason, "grantor_inactive");
});

test("a client_user grantor is only valid for their OWN party (SEC-03)", async () => {
  const client = await seedSupplier("Sibling");
  await draftFor(client, daysAgo(25));
  // clientGrantorId's membership pins them to clientA — a policy over a
  // SIBLING party must pause, exactly the wall the route enforces at grant.
  const [policy] = await getDb()
    .insert(clerkActionPoliciesTable)
    .values({
      firmId,
      clientPartyId: client,
      kind: "submit_overdue",
      maxTargetsPerRun: 50,
      grantedBy: clientGrantorId,
      grantedByRole: "client_user",
    })
    .returning();

  await runActionPolicySweep();
  const afterRow = await policyRow(policy.id);
  assert.equal(afterRow?.pausedReason, "grantor_inactive");
  assert.equal(afterRow?.lastRunDay, null);

  // The pause SIGNAL (round 29): a client-granted policy notifies the
  // client PARTY through the ordinary alert rails — default channels
  // (whatsapp + email, no prefs row), addressed by the party identity the
  // notification inbox reads. The GHOST pause in the previous test signaled
  // nobody: a staff-granted policy only reaches a grantor who still holds
  // a membership in the firm.
  const partySignals = await getDb()
    .select()
    .from(messagesTable)
    .where(
      and(
        eq(messagesTable.templateKey, "automation_paused"),
        eq(messagesTable.recipientPartyId, client),
      ),
    );
  assert.equal(partySignals.length, 2, "whatsapp + email default channels");
  const ghostSignals = await getDb()
    .select()
    .from(messagesTable)
    .where(
      and(
        eq(messagesTable.templateKey, "automation_paused"),
        eq(messagesTable.recipientUserId, ghostId),
      ),
    );
  assert.equal(ghostSignals.length, 0, "a departed grantor gets nothing");
});

test("a kind outside POLICY_KINDS pauses instead of falling through to the chaser builder", async () => {
  const client = await seedSupplier("BadKind");
  // Direct insert: the grant path's kind guard already refuses this — the
  // sweep must fail closed anyway (an ops fix-up or backfill bug is exactly
  // a row the API never wrote). draft_chasers is the dangerous case: the
  // dispatcher would burn unattended model calls on drafts nobody reads.
  const [policy] = await getDb()
    .insert(clerkActionPoliciesTable)
    .values({
      firmId,
      clientPartyId: client,
      kind: "draft_chasers",
      maxTargetsPerRun: 10,
      grantedBy: grantorId,
      grantedByRole: "firm_admin",
    })
    .returning();

  const result = await runActionPolicySweep();
  assert.equal(result.policiesRun, 0);
  assert.equal(result.policiesAutoPaused, 1);
  const afterRow = await policyRow(policy.id);
  assert.equal(afterRow?.pausedReason, "unknown_kind");
  assert.equal(afterRow?.pausedBy, null);
  assert.equal(afterRow?.lastRunDay, null, "no day consumed, nothing drafted");
});

test("lapsed consent pauses the policy — consent_missing — and signals the staff grantor's verified channel", async () => {
  const client = await seedSupplier("Lapsed");
  await draftFor(client, daysAgo(25));
  const policy = await grantActionPolicy(firmId, client, grantor, "submit_overdue");
  // The grantor's staff notification channel: verified email, opted in —
  // the digest rail's exact ownership gate.
  await getDb().insert(staffNotificationPreferencesTable).values({
    userId: grantorId,
    firmId,
    emailEnabled: true,
    email: `policy-grantor-${SALT}@test.local`,
    emailVerifiedAt: new Date(),
  });
  // Consent lapses AFTER the grant (the grant path itself refuses without
  // it — pinned above): the latest event wins.
  await recordConsent({
    partyId: client,
    layer: 1,
    action: "revoke",
    scope: "compliance",
    basis: "contract",
    channel: "test",
    actorId: grantorId,
  });

  const result = await runActionPolicySweep();
  assert.equal(result.policiesAutoPaused, 1);
  const afterRow = await policyRow(policy.id);
  assert.equal(afterRow?.pausedReason, "consent_missing");
  assert.equal(afterRow?.pausedBy, null);
  assert.equal(afterRow?.lastRunDay, null, "no run was consumed");

  // The staff grantor's signal landed on their inbox identity — email under
  // the verified-address gate (no registered devices, so no push row) —
  // and, per SEC-12, it is pointer-only: no reason, no client id.
  const staffSignals = await getDb()
    .select()
    .from(messagesTable)
    .where(
      and(
        eq(messagesTable.templateKey, "automation_paused"),
        eq(messagesTable.recipientUserId, grantorId),
      ),
    );
  assert.equal(staffSignals.length, 1);
  assert.equal(staffSignals[0].channel, "email");
  const serialized = JSON.stringify(staffSignals);
  assert.ok(
    !serialized.includes("consent_missing") && !serialized.includes(client),
    "the signal carries pointers only — the WHY lives on the dashboard",
  );
  // Re-consenting + resuming heals the grant without re-granting.
  await grantComplianceConsent(client, grantorId);
  await resumeActionPolicy(firmId, policy.id, grantor);
  const rerun = await runActionPolicySweep();
  assert.equal(rerun.policiesRun, 1);
  assert.equal((await policyRow(policy.id))?.lastRunDay, lagosDateString(new Date()));
});

test("a majority-failed run pauses the policy — failed_targets — and a dark messaging rail silences ONLY the signal", async () => {
  const client = await seedSupplier("Failing");
  // Both targets name the incomplete buyer: validation fails per invoice,
  // so the run records 2 failed of 2 requested — past the half tripwire.
  await draftFor(client, daysAgo(30), buyerNoTin);
  await draftFor(client, daysAgo(25), buyerNoTin);
  const policy = await grantActionPolicy(firmId, client, grantor, "submit_overdue");

  // The PL-02 pin (round-29 review MAJOR): with the platform messaging
  // rail dark, the tripwire must still pause and record — but send
  // NOTHING, not even a simulator ledger row.
  await getDb()
    .update(featureFlagsTable)
    .set({ enabled: false })
    .where(eq(featureFlagsTable.key, MESSAGING_FLAG));
  const grantorSignals = () =>
    getDb()
      .select()
      .from(messagesTable)
      .where(
        and(
          eq(messagesTable.templateKey, "automation_paused"),
          eq(messagesTable.recipientUserId, grantorId),
        ),
      );
  const signalsBefore = (await grantorSignals()).length;

  const result = await runActionPolicySweep();
  assert.equal(result.policiesRun, 1, "the run happened");
  assert.equal(result.policiesAutoPaused, 1, "…and tripped the wire");

  const afterRow = await policyRow(policy.id);
  assert.equal(afterRow?.pausedReason, "failed_targets");
  assert.equal(afterRow?.lastRunDay, lagosDateString(new Date()), "the run consumed the day");
  const [decision] = await getDb()
    .select()
    .from(clerkActionDecisionsTable)
    .where(eq(clerkActionDecisionsTable.policyId, policy.id));
  assert.equal(decision?.failedCount, 2);
  assert.equal(decision?.executedCount, 0);
  const audit = await lastAudit("clerk.action.policy_auto_paused");
  assert.equal((audit?.after as { reason?: string })?.reason, "failed_targets");
  assert.equal(
    (await grantorSignals()).length,
    signalsBefore,
    "a dark rail means no ledger row at all — the pause and audit still landed",
  );
  await getDb()
    .update(featureFlagsTable)
    .set({ enabled: true })
    .where(eq(featureFlagsTable.key, MESSAGING_FLAG));
});

test("an empty assembly leaves the day unclaimed — the sweep keeps watching", async () => {
  const client = await seedSupplier("Idle");
  const policy = await grantActionPolicy(firmId, client, grantor, "retry_failed");

  const result = await runActionPolicySweep();
  assert.equal(result.policiesRun, 0);
  assert.equal(result.policiesAutoPaused, 0);
  const afterRow = await policyRow(policy.id);
  assert.equal(afterRow?.lastRunDay, null);
  assert.equal(afterRow?.pausedAt, null);

  // Paper appears mid-day: the NEXT hourly pass runs it — same day.
  const db = getDb();
  const failedInv = randomUUID();
  await db.insert(invoicesTable).values({
    id: failedInv,
    firmId,
    supplierPartyId: client,
    buyerPartyId: buyer,
    invoiceNumber: `POL-${SALT}-RF1`,
    issueDate: daysAgo(10),
    status: "failed",
    grandTotal: "50000.00",
    subtotal: "46511.63",
    vatTotal: "3488.37",
  });
  const rerun = await runActionPolicySweep();
  assert.equal(rerun.policiesRun, 1);
  const [row] = await db
    .select({ status: invoicesTable.status })
    .from(invoicesTable)
    .where(eq(invoicesTable.id, failedInv));
  assert.equal(row.status, "submitted", "the retry ran through the ordinary path");
  const [decision] = await getDb()
    .select()
    .from(clerkActionDecisionsTable)
    .where(
      and(
        eq(clerkActionDecisionsTable.policyId, policy.id),
        eq(clerkActionDecisionsTable.kind, "retry_failed"),
      ),
    );
  assert.equal(decision?.executedCount, 1);
});

test("data.automation_status answers grants, pauses and cadence — and never executes anything", async () => {
  // A firm asker must name the client.
  const unpinned = await runDataIntent("data.automation_status", firmId);
  assert.match(unpinned!.text, /name the client/);

  // Flags dark (the foreign firm never opted in): the honest "not enabled".
  const dark = await runDataIntent("data.automation_status", foreignFirmId, {
    clientPartyId: randomUUID(),
  });
  assert.match(dark!.text, /not enabled for this firm/);

  const client = await seedSupplier("AskStatus");
  const none = await runDataIntent("data.automation_status", firmId, {
    clientPartyId: client,
  });
  assert.match(none!.text, /No standing approvals are in place/);
  assert.match(none!.text, /Automate daily/);

  const policy = await grantActionPolicy(firmId, client, grantor, "retry_failed", 10);
  const active = await runDataIntent("data.automation_status", firmId, {
    clientPartyId: client,
  });
  assert.match(active!.text, /auto-retry failed submissions — active/);
  assert.match(active!.text, /up to 10 per run/);
  assert.match(active!.text, /has not run yet/);
  assert.match(
    active!.text,
    /pause or revoke any of them from the dashboard/,
    "the answer points at the strip — Ask can never mutate a grant",
  );
  assert.equal(
    active!.facts.find((f) => f.key === "automation_active")?.value,
    "1",
  );

  await pauseActionPolicy(firmId, policy.id, grantor);
  const paused = await runDataIntent("data.automation_status", firmId, {
    clientPartyId: client,
  });
  assert.match(paused!.text, /PAUSED \(manual\)/);
  assert.equal(
    paused!.facts.find((f) => f.key === "automation_paused")?.value,
    "1",
  );
});
