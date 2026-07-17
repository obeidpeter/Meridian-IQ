import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  getDb,
  firmsTable,
  partiesTable,
  invoicesTable,
  usersTable,
  escalationsTable,
  operatorCasesTable,
  clerkBatchesTable,
  clerkCasesTable,
} from "@workspace/db";
import { computeOperatorBrief } from "./daily-brief.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Operator daily brief (round-12 idea #1). The brief is PLATFORM-WIDE by
// design (operator surface), and the shared test database carries rows from
// every other suite — so assertions are lower bounds plus presence, never
// exact equality against a shared pool.

const SALT = makeRunSalt();
const firmId = randomUUID();
const partyId = randomUUID();
const invoiceId = randomUUID();
const userId = randomUUID();

// One pinned clock for seed AND query: the brief takes `now` into its SQL,
// so a suite that straddles Lagos midnight between before() and the test
// body still agrees with itself about which day is "yesterday".
const NOW = new Date();

function lagosYesterdayNoonUtc(): Date {
  // 11:00 UTC = 12:00 Lagos, safely inside the previous Lagos day.
  const d = new Date(NOW.getTime() + 60 * 60 * 1000);
  d.setUTCDate(d.getUTCDate() - 1);
  d.setUTCHours(11, 0, 0, 0);
  return d;
}

before(async () => {
  const db = getDb();
  await db.insert(firmsTable).values({ id: firmId, name: `Brief Firm ${SALT}` });
  await db
    .insert(usersTable)
    .values({ id: userId, email: `brief-${SALT}@test.example` })
    .onConflictDoNothing();
  await db.insert(partiesTable).values({
    id: partyId,
    type: "client_business",
    legalName: `Brief Party ${SALT}`,
  });
  await db.insert(invoicesTable).values({
    id: invoiceId,
    firmId,
    supplierPartyId: partyId,
    buyerPartyId: partyId,
    invoiceNumber: `BRIEF-${SALT}`,
    issueDate: "2026-07-01",
  });
  await db.insert(operatorCasesTable).values([
    {
      firmId,
      clientPartyId: partyId,
      invoiceId,
      title: `Brief case ${SALT}`,
      priority: "high",
      status: "open",
    },
    {
      firmId,
      clientPartyId: partyId,
      invoiceId,
      title: `Unmapped code BRIEF_${SALT}: add a catalogue entry (seen ×1)`,
      priority: "medium",
      status: "open",
    },
  ]);
  await db.insert(escalationsTable).values({
    invoiceId,
    firmId,
    clientPartyId: partyId,
    reason: `Brief escalation ${SALT}`,
    status: "open",
  });
  await db.insert(clerkBatchesTable).values({
    firmId,
    createdBy: userId,
    name: `Brief batch ${SALT}`,
    sourceText: `doc ${SALT}`,
    status: "queued",
  });
  await db.insert(clerkCasesTable).values({
    kind: "extraction",
    status: "approved",
    sourceType: "text",
    firmId,
    createdBy: userId,
    decidedBy: userId,
    createdAt: lagosYesterdayNoonUtc(),
    updatedAt: lagosYesterdayNoonUtc(),
  });
});

test("the brief counts the seeded work as lower bounds with named oldest items", async () => {
  const brief = await computeOperatorBrief(NOW);
  const totalOpen = brief.openCases.byPriority.reduce(
    (s, p) => s + p.count,
    0,
  );
  assert.ok(totalOpen >= 2, "both seeded cases (open) are counted");
  assert.ok(
    brief.openCases.byPriority.some((p) => p.priority === "high"),
    "priority split includes the seeded high case",
  );
  assert.ok(brief.openCases.oldestTitle !== null);
  assert.ok(brief.unansweredEscalations.count >= 1);
  assert.ok(brief.unansweredEscalations.oldestReason !== null);
  assert.ok(brief.stuckBatches.count >= 1);
  assert.ok(brief.stuckBatches.oldestQueuedAt !== null);
  assert.ok(brief.unmappedCodeCases >= 1, "the unmapped-code case is seen");
  assert.ok(brief.decidedYesterday >= 1, "yesterday's decided case counted");
  assert.equal(typeof brief.clerkEnabled, "boolean");
  assert.equal(typeof brief.resistanceAlert, "boolean");
});
