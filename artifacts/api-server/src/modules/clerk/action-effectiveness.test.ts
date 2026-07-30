import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  getDb,
  clerkActionDecisionsTable,
  clerkActionPoliciesTable,
  firmsTable,
  invoicesTable,
  partiesTable,
  usersTable,
  type ActionTargetOutcome,
} from "@workspace/db";
import { bandExposure } from "../invoice/penalty-exposure";
import { computeActionEffectiveness } from "./action-effectiveness.ts";
import { daysAgo, makeRunSalt } from "../../test-helpers/fixtures.ts";

// Action effectiveness (round 29). Pinned invariants:
//  - decision-time tallies come straight from the ledger's count columns,
//    split auto (policyId set) vs manual;
//  - the NOW buckets re-read each EXECUTED submit target's current invoice
//    status: stamped-and-beyond counts as succeeded, a later rail rejection
//    surfaces as failedAgain (never buried), a purged/missing invoice lands
//    in other — the LEFT JOIN keeps the bucket honest;
//  - draft_chasers rows carry null NOW buckets (drafted text has no rail
//    lifecycle to verify);
//  - the exposure figure is bandExposure(executed submit_overdue).small —
//    the same lowest-band arithmetic every other s.104 surface uses;
//  - the window bounds everything (an old decision is invisible at 90 days
//    and visible at 365), and a sibling firm's ledger never leaks in.

const SALT = makeRunSalt();

const firmId = randomUUID();
const foreignFirmId = randomUUID();
const userId = randomUUID();
const client = randomUUID();
const foreignClient = randomUUID();
const buyer = randomUUID();

// Executed submit targets in every current-status bucket.
const invStamped = randomUUID();
const invFailedAgain = randomUUID();
const invInFlight = randomUUID();
const invRetryStamped = randomUUID();
const invPurged = randomUUID(); // never inserted — the missing-invoice bucket

let policyId: string;

function target(
  invoiceId: string,
  outcome: ActionTargetOutcome["outcome"],
): ActionTargetOutcome {
  return {
    invoiceId,
    invoiceNumber: `EFF-${SALT}-${invoiceId.slice(0, 4)}`,
    outcome,
    error: outcome === "submitted" || outcome === "drafted" ? null : "nope",
  };
}

async function seedDecision(input: {
  kind: string;
  targets: ActionTargetOutcome[];
  policyId?: string | null;
  firm?: string;
  clientParty?: string;
  createdAt?: Date;
}): Promise<void> {
  const executed = input.targets.filter(
    (t) => t.outcome === "submitted" || t.outcome === "drafted",
  ).length;
  const skipped = input.targets.filter(
    (t) => t.outcome === "skipped_not_eligible",
  ).length;
  await getDb()
    .insert(clerkActionDecisionsTable)
    .values({
      firmId: input.firm ?? firmId,
      clientPartyId: input.clientParty ?? client,
      kind: input.kind,
      decidedBy: userId,
      policyId: input.policyId ?? null,
      evidence: {},
      targets: input.targets,
      requestedCount: input.targets.length,
      executedCount: executed,
      skippedCount: skipped,
      failedCount: input.targets.length - executed - skipped,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    });
}

before(async () => {
  const db = getDb();
  await db.insert(usersTable).values({
    id: userId,
    email: `effect-${SALT}@test.local`,
  });
  await db.insert(firmsTable).values([
    { id: firmId, name: `Effect Firm ${SALT}` },
    { id: foreignFirmId, name: `Effect Foreign ${SALT}` },
  ]);
  await db.insert(partiesTable).values([
    {
      id: client,
      type: "client_business",
      legalName: `Effect Client ${SALT}`,
      tin: "40000000-0001",
    },
    {
      id: foreignClient,
      type: "client_business",
      legalName: `Effect Foreign Client ${SALT}`,
      tin: "40000000-0002",
    },
    { id: buyer, type: "buyer", legalName: `Effect Buyer ${SALT}` },
  ]);
  const invoice = (id: string, status: string) => ({
    id,
    firmId,
    supplierPartyId: client,
    buyerPartyId: buyer,
    invoiceNumber: `EFF-${SALT}-${id.slice(0, 4)}`,
    issueDate: daysAgo(30),
    status: status as "stamped",
    grandTotal: "1000.00",
    subtotal: "930.23",
    vatTotal: "69.77",
  });
  await db
    .insert(invoicesTable)
    .values([
      invoice(invStamped, "stamped"),
      invoice(invFailedAgain, "failed"),
      invoice(invInFlight, "submitted"),
      invoice(invRetryStamped, "settled"),
    ]);
  // The auto decision's authorizing grant — revoked at insert so the global
  // policy sweep can never pick this fixture up as live work.
  const [policy] = await db
    .insert(clerkActionPoliciesTable)
    .values({
      firmId,
      clientPartyId: client,
      kind: "submit_overdue",
      maxTargetsPerRun: 50,
      grantedBy: userId,
      grantedByRole: "firm_admin",
      revokedAt: new Date(),
      revokedBy: userId,
    })
    .returning({ id: clerkActionPoliciesTable.id });
  policyId = policy.id;

  // Auto submit_overdue: two executed (one now stamped, one failed again),
  // one skipped.
  await seedDecision({
    kind: "submit_overdue",
    policyId,
    targets: [
      target(invStamped, "submitted"),
      target(invFailedAgain, "submitted"),
      target(randomUUID(), "skipped_not_eligible"),
    ],
  });
  // Manual submit_overdue: one in flight, one invalid, one executed whose
  // invoice no longer exists (purge tolerance).
  await seedDecision({
    kind: "submit_overdue",
    targets: [
      target(invInFlight, "submitted"),
      target(randomUUID(), "invalid"),
      target(invPurged, "submitted"),
    ],
  });
  // Manual retry_failed: executed and since settled (succeeded).
  await seedDecision({
    kind: "retry_failed",
    targets: [target(invRetryStamped, "submitted")],
  });
  // Chaser batch: executed work with no rail lifecycle to verify.
  await seedDecision({
    kind: "draft_chasers",
    targets: [target(randomUUID(), "drafted")],
  });
  // Outside the default window — visible only at 365 days.
  await seedDecision({
    kind: "submit_overdue",
    targets: [target(randomUUID(), "submitted")],
    createdAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000),
  });
  // A sibling firm's ledger — must never leak in.
  await seedDecision({
    kind: "submit_overdue",
    firm: foreignFirmId,
    clientParty: foreignClient,
    targets: [target(randomUUID(), "submitted")],
  });
});

test("decision-time tallies, the auto split, and the NOW buckets are honest", async () => {
  const report = await computeActionEffectiveness(firmId, client);
  assert.equal(report.windowDays, 90);

  const byKind = new Map(report.kinds.map((k) => [k.kind, k]));
  const overdue = byKind.get("submit_overdue");
  assert.ok(overdue);
  assert.equal(overdue.decisions, 2);
  assert.equal(overdue.autoDecisions, 1, "one ran under the standing approval");
  assert.equal(overdue.requested, 6);
  assert.equal(overdue.executed, 4);
  assert.equal(overdue.skipped, 1);
  assert.equal(overdue.failed, 1);
  assert.equal(overdue.nowSucceeded, 1, "the stamped target");
  assert.equal(overdue.nowInFlight, 1, "still on the rails");
  assert.equal(
    overdue.nowFailedAgain,
    1,
    "a later rail rejection is surfaced, never buried",
  );
  assert.equal(overdue.nowOther, 1, "the purged invoice stays countable");

  const retry = byKind.get("retry_failed");
  assert.ok(retry);
  assert.equal(retry.decisions, 1);
  assert.equal(retry.autoDecisions, 0);
  assert.equal(retry.executed, 1);
  assert.equal(retry.nowSucceeded, 1, "settled counts as succeeded");

  const chasers = byKind.get("draft_chasers");
  assert.ok(chasers);
  assert.equal(chasers.executed, 1);
  assert.equal(chasers.nowSucceeded, null, "drafts have no rail lifecycle");
  assert.equal(chasers.nowFailedAgain, null);

  assert.deepEqual(report.totals, {
    decisions: 4,
    autoDecisions: 1,
    executed: 6,
    failed: 1,
  });
  // 4 executed submit_overdue MINUS the 1 that failed again: exposure the
  // rails later rejected is back, so it was never "removed".
  assert.equal(
    report.exposureFloorClearedNgn,
    bandExposure(3).small,
    "failed-again targets are subtracted from the cleared estimate",
  );
});

test("the window bounds the ledger, and a sibling firm never leaks in", async () => {
  const wide = await computeActionEffectiveness(firmId, client, 365);
  const overdue = wide.kinds.find((k) => k.kind === "submit_overdue");
  assert.equal(overdue?.decisions, 3, "the old decision appears at 365 days");
  assert.equal(wide.totals.decisions, 5);
  assert.equal(
    wide.exposureFloorClearedNgn,
    bandExposure(4).small,
    "the wider window's executed-still-standing count drives the estimate",
  );

  const foreign = await computeActionEffectiveness(foreignFirmId, client);
  assert.equal(
    foreign.totals.decisions,
    0,
    "the foreign firm sees nothing for a client it never decided on",
  );

  const empty = await computeActionEffectiveness(firmId, randomUUID());
  assert.deepEqual(empty.kinds, []);
  assert.equal(empty.exposureFloorClearedNgn, "0");

  // Fractional/oversized windows are clamped in the module (the contract's
  // zod coerces without .int() — a raw 1.5 must degrade, never 22P02).
  const fractional = await computeActionEffectiveness(firmId, client, 90.9);
  assert.equal(fractional.windowDays, 90);
  const oversized = await computeActionEffectiveness(firmId, client, 4000);
  assert.equal(oversized.windowDays, 365);
});

test("a malformed target row degrades to the other bucket — the report never 500s", async () => {
  // Only reachable via a hand-written ledger row (every real writer is
  // uuid-validated), but one such row must not permanently 500 the report
  // for the whole client. Seeded on its OWN client so the main
  // expectations above stay exact.
  const oddClient = randomUUID();
  await getDb().insert(partiesTable).values({
    id: oddClient,
    type: "client_business",
    legalName: `Effect Odd ${SALT}`,
    tin: "40000000-0003",
  });
  await seedDecision({
    kind: "submit_overdue",
    clientParty: oddClient,
    targets: [
      {
        invoiceId: "not-a-uuid",
        invoiceNumber: `EFF-${SALT}-odd`,
        outcome: "submitted",
        error: null,
      },
    ],
  });
  const report = await computeActionEffectiveness(firmId, oddClient);
  const overdue = report.kinds.find((k) => k.kind === "submit_overdue");
  assert.equal(overdue?.executed, 1);
  assert.equal(overdue?.nowOther, 1, "the junk id lands in other, countable");
  assert.equal(overdue?.nowSucceeded, 0);
});
