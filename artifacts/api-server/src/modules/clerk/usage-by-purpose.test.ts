import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getDb, clerkInferenceCallsTable, firmsTable } from "@workspace/db";
import { firmClerkUsage, firmClerkUsageByPurpose } from "./budget.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Per-purpose usage split (GET /clerk/usage byPurpose). Pinned invariants:
//  - same ledger, same firm filter and the same month window as
//  firmClerkUsage, so the split always sums to usedTokens;
//  - grouped by purpose, heaviest first;
//  - a previous month's spend never leaks into the split.

const SALT = makeRunSalt();
const firmId = randomUUID();
const HEAVY = `up_heavy_${SALT}`.slice(0, 40);
const LIGHT = `up_light_${SALT}`.slice(0, 40);

const ledgerRow = (purpose: string, promptTokens: number, completionTokens: number) => ({
  firmId,
  purpose,
  model: "usage-model",
  promptVersion: "v1",
  inputRef: `usage-${purpose}-${promptTokens}-${SALT}`,
  outputJson: { chars: 1 },
  schemaValid: true,
  outcome: "ok" as const,
  promptTokens,
  completionTokens,
});

before(async () => {
  const db = getDb();
  await db
    .insert(firmsTable)
    .values({ id: firmId, name: `Usage Firm ${SALT}` })
    .onConflictDoNothing();
  const monthStart = new Date(
    Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
  );
  await db.insert(clerkInferenceCallsTable).values([
    // Two calls under the heavy purpose, one under the light: 1700 vs 300.
    ledgerRow(HEAVY, 1000, 200),
    ledgerRow(HEAVY, 400, 100),
    ledgerRow(LIGHT, 250, 50),
    // Last month's spend: inside the firm filter, outside the month window.
    {
      ...ledgerRow(HEAVY, 9000, 900),
      inputRef: `usage-old-${SALT}`,
      createdAt: new Date(monthStart.getTime() - 24 * 60 * 60 * 1000),
    },
  ]);
});

test("usage by purpose groups the month's ledger, heaviest first, summing to usedTokens", async () => {
  const usage = await firmClerkUsage(firmId);
  const byPurpose = await firmClerkUsageByPurpose(firmId, usage.monthStart);

  // The firm is fresh, so the split is exact — no sibling-suite pollution.
  assert.deepEqual(byPurpose, [
    { purpose: HEAVY, tokens: 1700 },
    { purpose: LIGHT, tokens: 300 },
  ]);
  assert.equal(
    byPurpose.reduce((s, r) => s + r.tokens, 0),
    usage.usedTokens,
    "the split sums to the same month-to-date figure the budget gate uses",
  );
});
