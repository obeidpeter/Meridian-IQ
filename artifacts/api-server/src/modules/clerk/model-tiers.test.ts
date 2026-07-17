import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { desc, eq } from "drizzle-orm";
import { getDb, clerkInferenceCallsTable } from "@workspace/db";
import { modelForPurpose, parseModelTiers } from "./provider.ts";
import { getClerkMetrics } from "./metrics.ts";
import {
  fakeGateway,
  restoreClerkFlag,
  saveAndEnableClerkFlag,
} from "./test-support.ts";
import { z } from "zod/v4";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Per-purpose model tiers (round-7 idea #1) + platform spend meter (idea
// #3). Pinned invariants:
//  - the tier map is opt-in env; unset = one model for everything;
//  - eval purposes follow the extract_invoice tier unless explicitly
//  overridden — evals measure what production extraction runs;
//  - the ledger records the model that ACTUALLY served a tiered call;
//  - platform spend sums the ledger on the same UTC month boundary as the
//  per-firm budget, split by who funded the call.

const SALT = makeRunSalt();

before(async () => {
  await saveAndEnableClerkFlag();
});

after(async () => {
  await restoreClerkFlag();
});

test("parseModelTiers + modelForPurpose: opt-in routing with eval coupling", () => {
  const none = parseModelTiers(undefined);
  assert.equal(none.size, 0);
  assert.equal(modelForPurpose("segment_batch", none, "base"), "base");

  const tiers = parseModelTiers(
    " segment_batch = mini , classify_intent=mini, extract_invoice=big ",
  );
  assert.equal(modelForPurpose("segment_batch", tiers, "base"), "mini");
  assert.equal(modelForPurpose("extract_invoice", tiers, "base"), "big");
  // Eval purposes follow the extraction tier...
  assert.equal(modelForPurpose("eval_extract", tiers, "base"), "big");
  assert.equal(modelForPurpose("eval_canary", tiers, "base"), "big");
  // ...unless explicitly overridden.
  const explicit = parseModelTiers("eval_extract=elsewhere");
  assert.equal(modelForPurpose("eval_extract", explicit, "base"), "elsewhere");
  // Unmapped purposes and garbage entries fall back to the base model.
  assert.equal(modelForPurpose("digest", tiers, "base"), "base");
  assert.equal(parseModelTiers("nonsense,also=,=broken").size, 0);
});

test("the ledger records the model that actually served a tiered call", async () => {
  const promptVersion = `tiers-${SALT}`;
  const gateway = fakeGateway((req) => ({
    content: JSON.stringify({ ok: true }),
    promptTokens: 11,
    completionTokens: 5,
    // A tiered provider reports the model it routed to.
    model: req.purpose === "classify_intent" ? `mini-${SALT}` : "unexpected",
  }));
  const result = await gateway.infer<{ ok: boolean }>({
    purpose: "classify_intent",
    promptVersion,
    system: "test",
    user: "test",
    schemaName: "t",
    jsonSchema: { type: "object" },
    validator: z.object({ ok: z.boolean() }),
    inputForHash: `tiers-${SALT}`,
  });
  assert.equal(result.ok, true);
  const [row] = await getDb()
    .select({ model: clerkInferenceCallsTable.model })
    .from(clerkInferenceCallsTable)
    .where(eq(clerkInferenceCallsTable.promptVersion, promptVersion))
    .orderBy(desc(clerkInferenceCallsTable.createdAt))
    .limit(1);
  assert.equal(row.model, `mini-${SALT}`, "per-call model, not the default");
});

test("a provider throw still ledgers the tiered model, not the default", async () => {
  const promptVersion = `tiers-err-${SALT}`;
  const gateway = fakeGateway(() => {
    // The production provider attaches the routed model before rethrowing;
    // the gateway must carry it onto the ERROR ledger row.
    const err = new Error("upstream unavailable");
    (err as unknown as { clerkModel: string }).clerkModel = `mini-err-${SALT}`;
    throw err;
  });
  const result = await gateway.infer<{ ok: boolean }>({
    purpose: "classify_intent",
    promptVersion,
    system: "test",
    user: "test",
    schemaName: "t",
    jsonSchema: { type: "object" },
    validator: z.object({ ok: z.boolean() }),
    inputForHash: `tiers-err-${SALT}`,
  });
  assert.equal(result.ok, false);
  const [row] = await getDb()
    .select({
      model: clerkInferenceCallsTable.model,
      outcome: clerkInferenceCallsTable.outcome,
    })
    .from(clerkInferenceCallsTable)
    .where(eq(clerkInferenceCallsTable.promptVersion, promptVersion))
    .orderBy(desc(clerkInferenceCallsTable.createdAt))
    .limit(1);
  assert.equal(row.outcome, "error");
  assert.equal(row.model, `mini-err-${SALT}`, "failure cohorts under its tier");
});

test("platform spend sums the ledger with the funded split and a sane pace", async () => {
  const metrics = await getClerkMetrics(30);
  const spend = metrics.platformSpend;
  assert.match(spend.month, /^\d{4}-\d{2}$/);
  assert.equal(spend.totalTokens, spend.promptTokens + spend.completionTokens);
  assert.ok(spend.totalTokens >= 16, "the tiered call above is in this month");
  assert.equal(
    spend.firmFundedTokens + spend.platformFundedTokens,
    spend.totalTokens,
    "every token is funded by someone",
  );
  assert.ok(
    spend.projectedTokens >= spend.totalTokens,
    "a linear pace never projects below the spend so far",
  );
});
