import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  getDb,
  firmsTable,
  partiesTable,
  operatorCasesTable,
} from "@workspace/db";
import { getComplianceOperationsWorkspace } from "./compliance-operations.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// The exception queue is PLATFORM-WIDE (operator surface) and the shared
// test database carries rows from every other suite, so totals are asserted
// as lower bounds. The cap itself is exact: with more overdue high-priority
// cases seeded than the list holds, the SLA-ranked list must be full,
// all-overdue (nothing outranks overdue+high), and flagged truncated —
// while the window counts still cover every open item the cap hides.

const SALT = makeRunSalt();
const firmId = randomUUID();
const partyId = randomUUID();
const ITEM_LIST_CAP = 80;
const SEEDED = ITEM_LIST_CAP + 5;

before(async () => {
  const db = getDb();
  await db.insert(firmsTable).values({ id: firmId, name: `Caps Firm ${SALT}` });
  await db.insert(partiesTable).values({
    id: partyId,
    type: "client_business",
    legalName: `Caps Party ${SALT}`,
  });
  // A day old: opened_at + the 4-hour high-priority SLA is long past, so
  // every seeded case classifies overdue.
  const openedAt = new Date(Date.now() - 24 * 3_600_000);
  await db.insert(operatorCasesTable).values(
    Array.from({ length: SEEDED }, (_, index) => ({
      firmId,
      clientPartyId: partyId,
      title: `Caps case ${SALT} #${index}`,
      priority: "high" as const,
      status: "open" as const,
      openedAt,
    })),
  );
});

test("the exception queue caps at the SLA-ranked worst rows and counts the hidden tail", async () => {
  const workspace = await getComplianceOperationsWorkspace();

  assert.equal(workspace.items.length, ITEM_LIST_CAP);
  assert.equal(workspace.itemsTruncated, true);
  // With more overdue seeds than the cap, worst-first ordering means every
  // returned row is overdue — truncation only hid the healthier tail.
  assert.ok(workspace.items.every((item) => item.slaState === "overdue"));
  // The summary counts come from window aggregates over the FULL set, so
  // they keep counting the rows the cap hides.
  assert.ok(workspace.openItems >= SEEDED);
  assert.ok(workspace.overdueItems >= SEEDED);
  assert.ok(workspace.highPriorityItems >= SEEDED);
  assert.ok(workspace.unassignedCases >= SEEDED);
  assert.ok(workspace.openItems > workspace.items.length);
});
