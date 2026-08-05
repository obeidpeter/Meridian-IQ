import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import {
  getDb,
  clerkPlanPoliciesTable,
  clerkPlanRunsTable,
  engagementsTable,
  featureFlagsTable,
  firmsTable,
  membershipsTable,
  partiesTable,
  usersTable,
} from "@workspace/db";
import { createDraft } from "../invoice/service.ts";
import { setFirmOverride } from "../flags/flags.ts";
import type { Principal } from "../auth/rbac.ts";
import { ACTIONS_FLAG_KEY } from "./actions.ts";
import { POLICIES_FLAG_KEY } from "./action-policies.ts";
import {
  grantPlanPolicy,
  listPlanPolicies,
  revokePlanPoliciesForParty,
  revokePlanPolicy,
  runPlanPolicySweep,
} from "./plan-policies.ts";
import { lagosDateString } from "../../lib/lagos-time.ts";
import {
  restoreClerkFlag,
  saveAndEnableClerkFlag,
} from "./test-support.ts";
import { isDomainError } from "../../test-helpers/assertions.ts";
import { daysAgo, makeRunSalt } from "../../test-helpers/fixtures.ts";
import { firmPrincipal as makeFirmPrincipal } from "../../test-helpers/principals.ts";
import { grantComplianceConsent } from "../../test-helpers/seeders.ts";

// Recurring plan policies (round 33, Do with Clerk Phase 3). Pinned:
//  - grant walls: live engagement, one live grant per (firm,client,template);
//  - the monthly sweep mints ONE plan run per policy per Lagos month (the
//    lastRunMonth CAS), records it, and an already-claimed month runs
//    nothing again;
//  - an empty month consumes the month HONESTLY (no run row, audited);
//  - tripwires pause: a halted previous run, a demoted grantor;
//  - a dark flag skips without consuming the month;
//  - offboarding revokes the party's plan policies.
// The sweep is FLEET-WIDE: assertions pin the suite's own policy rows, never
// global counters, and after() revokes everything this suite granted
// (round-28 review M3 discipline).

const SALT = makeRunSalt();
const firmId = randomUUID();
const userId = randomUUID();
const clientA = randomUUID(); // engaged, consented, overdue paper
const clientB = randomUUID(); // engaged, consented, NO paper
const clientLoose = randomUUID(); // NOT engaged
const buyer = randomUUID();

const principal: Principal = makeFirmPrincipal(firmId, { userId });
const monthKey = lagosDateString().slice(0, 7);

async function loadPolicy(id: string) {
  const [row] = await getDb()
    .select()
    .from(clerkPlanPoliciesTable)
    .where(eq(clerkPlanPoliciesTable.id, id));
  return row;
}

before(async () => {
  await saveAndEnableClerkFlag();
  const db = getDb();
  for (const key of [ACTIONS_FLAG_KEY, POLICIES_FLAG_KEY]) {
    await db
      .insert(featureFlagsTable)
      .values({ key, enabled: false, releaseTag: "R3", description: "seed" })
      .onConflictDoNothing({ target: featureFlagsTable.key });
  }
  await db
    .insert(usersTable)
    .values({ id: userId, email: `plan-pol-${SALT}@test.local` })
    .onConflictDoNothing();
  await db.insert(firmsTable).values({ id: firmId, name: `PP Firm ${SALT}` });
  await setFirmOverride(ACTIONS_FLAG_KEY, firmId, true);
  await setFirmOverride(POLICIES_FLAG_KEY, firmId, true);
  await db.insert(membershipsTable).values({
    userId,
    firmId,
    role: "firm_admin",
  });
  await db.insert(partiesTable).values(
    [clientA, clientB, clientLoose, buyer].map((id, i) => ({
      id,
      type: (id === buyer ? "buyer" : "client_business") as
        | "buyer"
        | "client_business",
      legalName: `PP Party ${i} ${SALT}`,
      tin: `7000000${i}-0001`,
      street: `${i} Marina Rd`,
      city: "Lagos",
    })),
  );
  await db.insert(engagementsTable).values([
    { firmId, clientPartyId: clientA, type: "readiness_assessment", title: "pa" },
    { firmId, clientPartyId: clientB, type: "readiness_assessment", title: "pb" },
  ]);
  await grantComplianceConsent(clientA, userId);
  await grantComplianceConsent(clientB, userId);
  await createDraft(
    {
      firmId,
      supplierPartyId: clientA,
      buyerPartyId: buyer,
      invoiceNumber: `PP-${SALT}-1`,
      issueDate: daysAgo(30),
      dueDate: null,
      lines: [
        { description: "Goods", quantity: "1", unitPrice: "1000", vatRate: "0.075" },
      ],
    },
    userId,
  );
});

after(async () => {
  // A live policy is a standing instruction to a GLOBAL sweep — revoke
  // everything this suite granted, even when a test failed mid-way.
  await getDb()
    .update(clerkPlanPoliciesTable)
    .set({ revokedAt: new Date(), revokedBy: userId })
    .where(
      and(
        eq(clerkPlanPoliciesTable.firmId, firmId),
        isNull(clerkPlanPoliciesTable.revokedAt),
      ),
    );
  await restoreClerkFlag();
});

test("grant walls: engagement, duplicates, unknown templates", async () => {
  await assert.rejects(
    grantPlanPolicy(firmId, clientLoose, principal, "month_end_close"),
    isDomainError("NO_LIVE_ENGAGEMENT"),
  );
  await assert.rejects(
    grantPlanPolicy(firmId, clientA, principal, "no_such_template"),
    isDomainError("UNKNOWN_TEMPLATE"),
  );
  const policy = await grantPlanPolicy(firmId, clientA, principal, "month_end_close");
  assert.equal(policy.templateKey, "month_end_close");
  await assert.rejects(
    grantPlanPolicy(firmId, clientA, principal, "month_end_close"),
    isDomainError("POLICY_EXISTS"),
  );
  const list = await listPlanPolicies(firmId, clientA);
  assert.ok(list.enabled);
  assert.ok(list.policies.some((p) => p.id === policy.id));
  // Revoked grants free the live slot — a fresh grant succeeds.
  await revokePlanPolicy(firmId, policy.id, principal);
  const again = await grantPlanPolicy(firmId, clientA, principal, "month_end_close");
  assert.notEqual(again.id, policy.id);
  await revokePlanPolicy(firmId, again.id, principal);
});

test("the sweep mints one run per month (CAS); an empty month consumes honestly", async () => {
  const withPaper = await grantPlanPolicy(firmId, clientA, principal, "month_end_close");
  const empty = await grantPlanPolicy(firmId, clientB, principal, "month_end_close");
  try {
    await runPlanPolicySweep();
    const ranA = await loadPolicy(withPaper.id);
    assert.equal(ranA.lastRunMonth, monthKey);
    assert.ok(ranA.lastRunId, "a run was minted and recorded");
    const [run] = await getDb()
      .select()
      .from(clerkPlanRunsTable)
      .where(eq(clerkPlanRunsTable.id, ranA.lastRunId!));
    assert.equal(run.templateKey, "month_end_close");
    assert.equal(run.approvedBy, userId);

    const ranB = await loadPolicy(empty.id);
    assert.equal(ranB.lastRunMonth, monthKey, "the empty month is consumed");
    assert.equal(ranB.lastRunId, null, "no run row for an empty month");

    // Same month again: nothing new mints.
    await runPlanPolicySweep();
    const still = await loadPolicy(withPaper.id);
    assert.equal(still.lastRunId, ranA.lastRunId);
    assert.equal(still.pausedAt, null);
  } finally {
    await revokePlanPolicy(firmId, withPaper.id, principal);
    await revokePlanPolicy(firmId, empty.id, principal);
  }
});

test("a halted previous run pauses the policy instead of repeating it", async () => {
  const policy = await grantPlanPolicy(firmId, clientB, principal, "month_end_close");
  try {
    const [haltedRun] = await getDb()
      .insert(clerkPlanRunsTable)
      .values({
        firmId,
        templateKey: "month_end_close",
        status: "halted",
        haltReason: "failed_targets",
        steps: [],
        approvedBy: userId,
      })
      .returning();
    await getDb()
      .update(clerkPlanPoliciesTable)
      .set({ lastRunMonth: "2020-01", lastRunId: haltedRun.id })
      .where(eq(clerkPlanPoliciesTable.id, policy.id));
    await runPlanPolicySweep();
    const paused = await loadPolicy(policy.id);
    assert.ok(paused.pausedAt, "the tripwire paused it");
    assert.equal(paused.pausedReason, "run_halted");
    assert.equal(paused.lastRunMonth, "2020-01", "no month consumed");
  } finally {
    await revokePlanPolicy(firmId, policy.id, principal);
  }
});

test("a demoted grantor pauses the policy (grantor_inactive)", async () => {
  const policy = await grantPlanPolicy(firmId, clientB, principal, "month_end_close");
  const membership = await getDb()
    .delete(membershipsTable)
    .where(
      and(eq(membershipsTable.userId, userId), eq(membershipsTable.firmId, firmId)),
    )
    .returning();
  try {
    await runPlanPolicySweep();
    const paused = await loadPolicy(policy.id);
    assert.equal(paused.pausedReason, "grantor_inactive");
  } finally {
    await getDb().insert(membershipsTable).values(membership);
    await revokePlanPolicy(firmId, policy.id, principal);
  }
});

test("a dark flag skips without consuming the month", async () => {
  const policy = await grantPlanPolicy(firmId, clientB, principal, "month_end_close");
  await setFirmOverride(ACTIONS_FLAG_KEY, firmId, false);
  try {
    await runPlanPolicySweep();
    const skipped = await loadPolicy(policy.id);
    assert.equal(skipped.lastRunMonth, null, "the month is NOT consumed");
    assert.equal(skipped.pausedAt, null, "dark is a skip, not a tripwire");
  } finally {
    await setFirmOverride(ACTIONS_FLAG_KEY, firmId, true);
    await revokePlanPolicy(firmId, policy.id, principal);
  }
});

test("offboarding revokes the party's plan policies", async () => {
  const policy = await grantPlanPolicy(firmId, clientB, principal, "month_end_close");
  const revoked = await revokePlanPoliciesForParty(firmId, clientB, userId);
  assert.ok(revoked >= 1);
  const row = await loadPolicy(policy.id);
  assert.ok(row.revokedAt, "the grant died with the relationship");
});
