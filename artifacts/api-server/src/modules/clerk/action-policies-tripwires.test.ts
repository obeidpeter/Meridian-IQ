import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
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
  submissionAttemptsTable,
  usersTable,
  type ActionTargetOutcome,
} from "@workspace/db";
import { createDraft } from "../invoice/service.ts";
import { setFirmOverride } from "../flags/flags.ts";
import { recordConsent } from "../consent/consent.ts";
import type { Principal } from "../auth/rbac.ts";
import {
  ACTIONS_FLAG_KEY,
  AUTO_RETRY_ATTEMPT_CAP,
  listActionProposals,
} from "./actions.ts";
import {
  ACTION_POLICY_AUTO_PAUSE_ALERT,
  POLICIES_FLAG_KEY,
  grantActionPolicy,
  notifyPolicyGranted,
  runActionPolicySweep,
} from "./action-policies.ts";
import { decisionRailStanding } from "./action-effectiveness.ts";
import { isDomainError } from "../../test-helpers/assertions.ts";
import { daysAgo, makeRunSalt } from "../../test-helpers/fixtures.ts";
import {
  clientPrincipal,
  firmPrincipal as makeFirmPrincipal,
} from "../../test-helpers/principals.ts";
import { grantComplianceConsent } from "../../test-helpers/seeders.ts";
import { lagosDateString } from "../../lib/lagos-time.ts";

// Standing approvals, round-30 review fixes. Pinned invariants:
//  - the AUTOMATED retry assembly drops invoices with
//    AUTO_RETRY_ATTEMPT_CAP+ submission attempts while the HUMAN proposal
//    keeps offering them (mechanism 1 of the rail-rejection fix);
//  - a previous run whose submitted targets came back 'failed' (the rails'
//    asynchronous verdict) pauses the policy — rail_rejections — INSTEAD of
//    running that day (mechanism 2, riding the effectiveness report's own
//    decisionRailStanding helper);
//  - a grant needs a LIVE engagement (open/in_progress), and an engagement
//    archived AFTER the grant pauses the policy per run — engagement_closed;
//  - a run that THROWS pauses the policy — run_error — instead of silently
//    retrying every day (the day may already be claimed);
//  - auto-pauses raise a durable, counts-only operator alert on the audit
//    ledger (once per Lagos day);
//  - a GRANT notifies the side that did not click: staff grant → the client
//    party via the consent-gated fan-out (automation_granted), client grant
//    → firm staff under their verified-email/push opt-ins — and notification
//    failure or a dark messaging rail never fails the grant.
// Fixtures are salted — submitted invoices persist in the shared DB.

const SALT = makeRunSalt();

const firmId = randomUUID();
const grantorId = randomUUID(); // firm_admin membership, no staff prefs
const staffOptedInId = randomUUID(); // firm_staff, verified email prefs
const staffUnverifiedId = randomUUID(); // firm_staff, email prefs UNVERIFIED
const staffNoPrefsId = randomUUID(); // firm_staff, no prefs row at all
const clientGrantorId = randomUUID(); // client_user, pinned in its test

const LINE = {
  description: "Goods",
  quantity: "1",
  unitPrice: "1000",
  vatRate: "0.075",
};

const grantor: Principal = makeFirmPrincipal(firmId, { userId: grantorId });

function hash(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
}

// One engaged+consented supplier party per scenario so sweeps never bleed
// into each other's paper (the action-policies suite's idiom).
async function seedSupplier(
  tag: string,
  engagementStatus: "open" | "in_progress" | "completed" | "archived" = "open",
): Promise<string> {
  const id = randomUUID();
  const db = getDb();
  await db.insert(partiesTable).values({
    id,
    type: "client_business",
    legalName: `Trip ${tag} ${SALT}`,
    tin: `31${String(Math.abs(hash(tag + SALT)) % 1_000_000).padStart(6, "0")}-0001`,
    street: "1 Marina Rd",
    city: "Lagos",
  });
  await db.insert(engagementsTable).values({
    firmId,
    clientPartyId: id,
    type: "readiness_assessment",
    title: `trip ${tag}`,
    status: engagementStatus,
  });
  await grantComplianceConsent(id, grantorId);
  return id;
}

let buyer: string;
let n = 0;
function draftFor(
  supplierPartyId: string,
  issueDate: string,
): Promise<{ invoice: { id: string } }> {
  n += 1;
  return createDraft(
    {
      firmId,
      supplierPartyId,
      buyerPartyId: buyer,
      invoiceNumber: `TRIP-${SALT}-${n}`,
      issueDate,
      dueDate: null,
      lines: [LINE],
    },
    grantorId,
  );
}

let f = 0;
async function failedInvoice(
  supplierPartyId: string,
  issueDate: string,
  attemptCount: number,
): Promise<string> {
  f += 1;
  const id = randomUUID();
  const db = getDb();
  await db.insert(invoicesTable).values({
    id,
    firmId,
    supplierPartyId,
    buyerPartyId: buyer,
    invoiceNumber: `TRIP-${SALT}-F${f}`,
    issueDate,
    status: "failed",
    grandTotal: "50000.00",
    subtotal: "46511.63",
    vatTotal: "3488.37",
  });
  if (attemptCount > 0) {
    await db.insert(submissionAttemptsTable).values(
      Array.from({ length: attemptCount }, (_, i) => ({
        invoiceId: id,
        rail: "rail_primary" as const,
        attemptNo: i + 1,
        idempotencyKey: `trip-${SALT}-f${f}-${i + 1}`,
        status: "rejected" as const,
        errorCode: "MBS_INVALID_TIN",
      })),
    );
  }
  return id;
}

async function policyRow(id: string) {
  const [row] = await getDb()
    .select()
    .from(clerkActionPoliciesTable)
    .where(eq(clerkActionPoliciesTable.id, id));
  return row;
}

async function invoiceStatus(id: string): Promise<string> {
  const [row] = await getDb()
    .select({ status: invoicesTable.status })
    .from(invoicesTable)
    .where(eq(invoicesTable.id, id));
  return row!.status;
}

async function grantedMessagesForParty(clientPartyId: string) {
  return getDb()
    .select()
    .from(messagesTable)
    .where(
      and(
        eq(messagesTable.templateKey, "automation_granted"),
        eq(messagesTable.recipientPartyId, clientPartyId),
      ),
    );
}

async function grantedMessagesForUser(userId: string) {
  return getDb()
    .select()
    .from(messagesTable)
    .where(
      and(
        eq(messagesTable.templateKey, "automation_granted"),
        eq(messagesTable.recipientUserId, userId),
      ),
    );
}

// Policy ids the sweep auto-paused in this file — the fleet-alert test pins
// that the operator alert carries COUNTS, never these.
const pausedPolicyIds: string[] = [];

const MESSAGING_FLAG = "messaging_notifications";
let messagingFlagWasEnabled: boolean | null = null;

before(async () => {
  const db = getDb();
  // The messaging rail, save/restore exactly as found (the action-policies
  // suite's idiom): every grant/pause signal gates on it (PL-02).
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
  // Both action flag rows exactly as boot seeding ships them: DARK. This
  // firm opts in via per-firm overrides only.
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
    { id: grantorId, email: `trip-${SALT}@test.local` },
    { id: staffOptedInId, email: `trip-staff-${SALT}@test.local` },
    { id: staffUnverifiedId, email: `trip-unverified-${SALT}@test.local` },
    { id: staffNoPrefsId, email: `trip-noprefs-${SALT}@test.local` },
    { id: clientGrantorId, email: `trip-client-${SALT}@test.local` },
  ]);
  await db.insert(firmsTable).values({ id: firmId, name: `Trip Firm ${SALT}` });
  buyer = randomUUID();
  await db.insert(partiesTable).values({
    id: buyer,
    type: "buyer",
    legalName: `Trip Buyer ${SALT}`,
    tin: "20000000-0003",
    street: "3 Broad St",
    city: "Lagos",
  });
  await db.insert(membershipsTable).values([
    { userId: grantorId, firmId, role: "firm_admin" },
    { userId: staffOptedInId, firmId, role: "firm_staff" },
    { userId: staffUnverifiedId, firmId, role: "firm_staff" },
    { userId: staffNoPrefsId, firmId, role: "firm_staff" },
  ]);
  await db.insert(staffNotificationPreferencesTable).values([
    {
      userId: staffOptedInId,
      firmId,
      emailEnabled: true,
      email: `trip-staff-inbox-${SALT}@test.local`,
      emailVerifiedAt: new Date(),
      pushEnabled: false,
    },
    {
      // Enabled but NEVER verified — the proven-ownership gate must hold.
      userId: staffUnverifiedId,
      firmId,
      emailEnabled: true,
      email: `trip-unverified-inbox-${SALT}@test.local`,
    },
  ]);
  await setFirmOverride(ACTIONS_FLAG_KEY, firmId, true);
  await setFirmOverride(POLICIES_FLAG_KEY, firmId, true);
});

// A live policy is a standing instruction to a GLOBAL sweep — revoke
// everything this suite granted so later suites' sweeps never inherit it
// (the action-policies suite's after() discipline), and put the messaging
// flag back exactly as found.
after(async () => {
  const db = getDb();
  await db
    .update(clerkActionPoliciesTable)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(clerkActionPoliciesTable.firmId, firmId),
        isNull(clerkActionPoliciesTable.revokedAt),
      ),
    );
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

test("a grant refuses without a live engagement — completed/archived books of work do not count", async () => {
  // Consent but NO engagement at all: the relationship wall answers first.
  const orphan = randomUUID();
  const db = getDb();
  await db.insert(partiesTable).values({
    id: orphan,
    type: "client_business",
    legalName: `Trip Orphan ${SALT}`,
    tin: "31000000-0009",
    street: "2 Marina Rd",
    city: "Lagos",
  });
  await grantComplianceConsent(orphan, grantorId);
  await assert.rejects(
    grantActionPolicy(firmId, orphan, grantor, "submit_overdue"),
    isDomainError("NO_LIVE_ENGAGEMENT", 409),
  );

  // A completed engagement exists — still not a LIVE one.
  await db.insert(engagementsTable).values({
    firmId,
    clientPartyId: orphan,
    type: "readiness_assessment",
    title: "trip orphan done",
    status: "completed",
  });
  await assert.rejects(
    grantActionPolicy(firmId, orphan, grantor, "submit_overdue"),
    isDomainError("NO_LIVE_ENGAGEMENT", 409),
  );

  // in_progress counts as live — the client-statement enumeration.
  await db.insert(engagementsTable).values({
    firmId,
    clientPartyId: orphan,
    type: "retainer",
    title: "trip orphan live",
    status: "in_progress",
  });
  const policy = await grantActionPolicy(
    firmId,
    orphan,
    grantor,
    "submit_overdue",
  );
  assert.equal(policy.clientPartyId, orphan);
});

test("the attempt cap excludes rail-hammered invoices from the AUTOMATED run but not from the human proposal", async () => {
  const client = await seedSupplier("Cap");
  // At the cap: excluded from automation for good (the ledger only grows).
  const capped = await failedInvoice(client, daysAgo(12), AUTO_RETRY_ATTEMPT_CAP);
  // Under the cap: still automatable.
  const fresh = await failedInvoice(client, daysAgo(10), 1);
  const policy = await grantActionPolicy(firmId, client, grantor, "retry_failed");

  // The HUMAN proposal keeps showing both — a person may still choose the
  // capped one deliberately (and the shape is the historical one).
  const { actions } = await listActionProposals(firmId, client);
  const retry = actions.find((a) => a.kind === "retry_failed");
  assert.ok(retry, "the human retry proposal exists");
  assert.equal(retry.targetCount, 2, "the human count includes the capped invoice");
  assert.deepEqual(
    retry.targets.map((t) => t.invoiceId).sort(),
    [capped, fresh].sort(),
  );

  // The automated run takes ONLY the under-cap invoice.
  await runActionPolicySweep();
  const afterRow = await policyRow(policy.id);
  assert.equal(afterRow?.lastRunDay, lagosDateString(new Date()), "the run happened");
  assert.equal(afterRow?.pausedAt, null, "a capped candidate is no tripwire");
  const [decision] = await getDb()
    .select()
    .from(clerkActionDecisionsTable)
    .where(eq(clerkActionDecisionsTable.policyId, policy.id));
  assert.ok(decision, "one decision for the day");
  assert.equal(decision.requestedCount, 1, "the capped invoice never entered the batch");
  assert.equal(decision.targets[0].invoiceId, fresh);
  assert.equal(await invoiceStatus(fresh), "submitted", "the healthy retry is real");
  assert.equal(
    await invoiceStatus(capped),
    "failed",
    "the rail-hammered invoice is left for a human",
  );
});

test("rail rejections on the PREVIOUS run pause the policy instead of running — rail_rejections", async () => {
  const client = await seedSupplier("Rails");
  // Today's would-be candidate (1 prior attempt — well under the cap).
  const candidate = await failedInvoice(client, daysAgo(9), 1);
  // Yesterday's run: the decision recorded 'submitted' (enqueue-time truth),
  // but the rails since rejected it — the invoice is back in 'failed'.
  const bounced = await failedInvoice(client, daysAgo(15), 2);
  const policy = await grantActionPolicy(firmId, client, grantor, "retry_failed");
  const target: ActionTargetOutcome = {
    invoiceId: bounced,
    invoiceNumber: `TRIP-${SALT}-bounced`,
    outcome: "submitted",
    error: null,
  };
  const [previous] = await getDb()
    .insert(clerkActionDecisionsTable)
    .values({
      firmId,
      clientPartyId: client,
      kind: "retry_failed",
      decidedBy: grantorId,
      policyId: policy.id,
      evidence: {},
      targets: [target],
      requestedCount: 1,
      executedCount: 1,
      skippedCount: 0,
      failedCount: 0,
    })
    .returning();

  // The tripwire reads through the effectiveness report's own helper — one
  // SQL spelling of nowFailedAgain, pinned here at the seam the sweep uses.
  assert.deepEqual(await decisionRailStanding(previous.id), {
    submitted: 1,
    nowFailedAgain: 1,
  });

  await runActionPolicySweep();
  const afterRow = await policyRow(policy.id);
  assert.ok(afterRow?.pausedAt, "the policy paused");
  assert.equal(afterRow?.pausedReason, "rail_rejections");
  assert.equal(afterRow?.pausedBy, null, "the system paused it, not a person");
  assert.equal(afterRow?.lastRunDay, null, "the pause happened INSTEAD of the run");
  assert.equal(
    await invoiceStatus(candidate),
    "failed",
    "nothing was re-enqueued to the rails",
  );
  assert.equal(await invoiceStatus(bounced), "failed");
  const decisions = await getDb()
    .select({ id: clerkActionDecisionsTable.id })
    .from(clerkActionDecisionsTable)
    .where(eq(clerkActionDecisionsTable.policyId, policy.id));
  assert.equal(decisions.length, 1, "no new decision — the day did not run");
  const [audit] = await getDb()
    .select()
    .from(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.action, "clerk.action.policy_auto_paused"),
        eq(auditEventsTable.entityId, policy.id),
      ),
    );
  assert.equal((audit?.after as { reason?: string })?.reason, "rail_rejections");
  pausedPolicyIds.push(policy.id);
});

test("an engagement archived AFTER the grant pauses the policy — engagement_closed", async () => {
  const client = await seedSupplier("Wound");
  const overdue = (await draftFor(client, daysAgo(20))).invoice.id;
  const policy = await grantActionPolicy(firmId, client, grantor, "submit_overdue");
  // The firm winds the client down: the only engagement goes archived.
  await getDb()
    .update(engagementsTable)
    .set({ status: "archived" })
    .where(eq(engagementsTable.clientPartyId, client));

  await runActionPolicySweep();
  const afterRow = await policyRow(policy.id);
  assert.equal(afterRow?.pausedReason, "engagement_closed");
  assert.equal(afterRow?.pausedBy, null);
  assert.equal(afterRow?.lastRunDay, null, "a pause is not a run");
  assert.equal(
    await invoiceStatus(overdue),
    "draft",
    "nothing was submitted for the offboarded relationship",
  );
  pausedPolicyIds.push(policy.id);
});

test("a thrown run pauses the policy — run_error — instead of silently retrying tomorrow", async () => {
  const client = await seedSupplier("Throw");
  await failedInvoice(client, daysAgo(8), 1);
  const policy = await grantActionPolicy(firmId, client, grantor, "retry_failed");
  // A decision row whose targets jsonb is NOT an array: only a hand-written
  // ledger row can look like this (every real writer stores an array), and
  // it makes the run THROW (jsonb_array_elements refuses an object) — the
  // deterministic stand-in for any mid-run crash. The sweep must fail
  // CLOSED: pause, audit, and keep going.
  await getDb()
    .insert(clerkActionDecisionsTable)
    .values({
      firmId,
      clientPartyId: client,
      kind: "retry_failed",
      decidedBy: grantorId,
      policyId: policy.id,
      evidence: {},
      targets: {} as unknown as ActionTargetOutcome[],
      requestedCount: 0,
      executedCount: 0,
      skippedCount: 0,
      failedCount: 0,
    });

  const result = await runActionPolicySweep();
  assert.ok(result.policiesAutoPaused >= 1, "the pause is counted");
  const afterRow = await policyRow(policy.id);
  assert.ok(afterRow?.pausedAt, "the thrown run paused the policy");
  assert.equal(afterRow?.pausedReason, "run_error");
  assert.equal(afterRow?.pausedBy, null);
  const [audit] = await getDb()
    .select()
    .from(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.action, "clerk.action.policy_auto_paused"),
        eq(auditEventsTable.entityId, policy.id),
      ),
    );
  assert.equal((audit?.after as { reason?: string })?.reason, "run_error");
  pausedPolicyIds.push(policy.id);
});

test("auto-pauses raise the durable operator alert — counts only, once per Lagos day", async () => {
  // The sweeps above auto-paused policies, so today's fleet alert must be on
  // the ledger. Existence (not appended-this-pass) is the pin: the audit
  // ledger dedups the alert across passes AND suites — whichever pass paused
  // first today wrote it.
  const today = lagosDateString(new Date());
  const [alert] = await getDb()
    .select()
    .from(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.action, ACTION_POLICY_AUTO_PAUSE_ALERT),
        eq(auditEventsTable.entityId, `auto-paused:${today}`),
      ),
    )
    .limit(1);
  assert.ok(alert, "the fleet alert landed on the audit ledger");
  assert.equal(alert.actorId, "action-policy-sweep");
  const payload = alert.after as Record<string, unknown>;
  assert.equal(typeof payload.policiesAutoPaused, "number");
  assert.equal(typeof payload.policiesDue, "number");
  assert.equal(typeof payload.policiesRun, "number");
  // Pointer-only (SEC-12): counts ride the alert, never which policies —
  // per-policy detail lives on each policy_auto_paused audit row.
  const serialized = JSON.stringify(alert.after);
  assert.ok(pausedPolicyIds.length >= 3, "the earlier tests recorded their pauses");
  for (const id of pausedPolicyIds) {
    assert.ok(!serialized.includes(id), "no policy id rides the fleet alert");
  }
});

test("a staff grant notifies the client party — consent-gated, and a dark rail or failure never fails the grant", async () => {
  const client = await seedSupplier("Notify");
  assert.equal((await grantedMessagesForParty(client)).length, 0);

  // Staff grants; the client (whose paper the autopilot will file) is told
  // through the ordinary alert rails: default channels with no prefs row are
  // whatsapp + email (push skips — no registered devices).
  const policy = await grantActionPolicy(firmId, client, grantor, "submit_overdue");
  const signals = await grantedMessagesForParty(client);
  assert.equal(signals.length, 2, "whatsapp + email default channels");
  assert.deepEqual(signals.map((s) => s.channel).sort(), ["email", "whatsapp"]);
  // Pointer-only over the wire (SEC-12): what a transport sees is the lossy
  // ref + the entity pointer — never the raw party id or the policy kind.
  // (recipientPartyId is the LEDGER's identity column, not transport data.)
  for (const s of signals) {
    assert.ok(s.recipientRef.startsWith("ref-"), "lossy party ref only");
    assert.ok(s.entityId?.startsWith("pol-"), "opaque policy pointer only");
    assert.ok(!s.entityId?.includes("submit"), "no kind rides the pointer");
  }

  // PL-02: the platform messaging kill switch silences the signal — and the
  // grant itself still succeeds (notification is best-effort by contract).
  await getDb()
    .update(featureFlagsTable)
    .set({ enabled: false })
    .where(eq(featureFlagsTable.key, MESSAGING_FLAG));
  const darkGrant = await grantActionPolicy(firmId, client, grantor, "retry_failed");
  assert.ok(darkGrant.id, "a dark rail never fails the grant");
  assert.equal(
    (await grantedMessagesForParty(client)).length,
    2,
    "a dark rail means no new ledger rows at all",
  );
  await getDb()
    .update(featureFlagsTable)
    .set({ enabled: true })
    .where(eq(featureFlagsTable.key, MESSAGING_FLAG));

  // CORE-03 inside fanOutAlert: with consent revoked, a replay of the grant
  // signal sends NOTHING — consent wins over notification.
  await recordConsent({
    partyId: client,
    layer: 1,
    action: "revoke",
    scope: "compliance",
    basis: "contract",
    channel: "test",
    actorId: grantorId,
  });
  await notifyPolicyGranted(policy);
  assert.equal(
    (await grantedMessagesForParty(client)).length,
    2,
    "no consent, no message — the gate lives inside the fan-out",
  );
});

test("a client grant notifies firm staff under their opt-ins — verified email only, nothing for the unverified or unsubscribed", async () => {
  const client = await seedSupplier("ClientGrant");
  await getDb().insert(membershipsTable).values({
    userId: clientGrantorId,
    firmId,
    role: "client_user",
    clientPartyId: client,
  });

  const asClient = clientPrincipal(firmId, client, { userId: clientGrantorId });
  await grantActionPolicy(firmId, client, asClient, "submit_overdue");

  // The staff member with a VERIFIED, enabled email gets exactly one signal;
  // push stays quiet (their opt-in is off).
  const optedIn = await grantedMessagesForUser(staffOptedInId);
  assert.equal(optedIn.length, 1);
  assert.equal(optedIn[0].channel, "email");
  assert.equal(optedIn[0].templateKey, "automation_granted");
  // The unverified address and the member without prefs get nothing — the
  // digest rail's proven-ownership/opt-in posture, exactly.
  assert.equal((await grantedMessagesForUser(staffUnverifiedId)).length, 0);
  assert.equal((await grantedMessagesForUser(staffNoPrefsId)).length, 0);
  assert.equal(
    (await grantedMessagesForUser(clientGrantorId)).length, 0,
    "the grantor is not notified — they clicked",
  );
  assert.equal(
    (await grantedMessagesForParty(client)).length, 0,
    "a client grant notifies the FIRM side only",
  );
});
