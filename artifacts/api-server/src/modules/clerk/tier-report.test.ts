import { test, before } from "node:test";
import assert from "node:assert/strict";
import { getDb, runInBypassContext, clerkInferenceCallsTable } from "@workspace/db";
import {
  computeTierReport,
  tierRecommendation,
  TIER_MIN_CALLS,
} from "./tier-report.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Tier-suggestion report (round-9 idea #3). Pinned invariants:
//  - the recommendation rule is pure and deterministic — volume floor,
//  validity threshold, stakes purposes, tiered/revert semantics;
//  - the report reads the ledger (bypass posture) and the tier map actually
//  in force, so its "current model" column can never lie;
//  - killed calls never count against a model's validity.

const SALT = makeRunSalt();
const PURPOSE = `tier_probe_${SALT.replace(/-/g, "")}`;

before(async () => {
  // Seed enough ledger rows for the probe purpose to clear the volume floor:
  // all ok, plus a killed row that must not hurt validity. The ledger is
  // append-only (inserts are fine) and bypass-only to read.
  const rows: (typeof clerkInferenceCallsTable.$inferInsert)[] = [];
  for (let i = 0; i < TIER_MIN_CALLS; i++) {
    rows.push({
      purpose: PURPOSE,
      model: "probe-model",
      promptVersion: `tier-${SALT}`,
      inputRef: `tier-${SALT}-${i}`,
      outputJson: {},
      schemaValid: true,
      outcome: "ok" as const,
      promptTokens: 100,
      completionTokens: 10,
    });
  }
  rows.push({
    purpose: PURPOSE,
    model: "probe-model",
    promptVersion: `tier-${SALT}`,
    inputRef: `tier-${SALT}-killed`,
    outputJson: null,
    schemaValid: false,
    outcome: "killed" as const,
    promptTokens: null,
    completionTokens: null,
  });
  await runInBypassContext(() =>
    getDb().insert(clerkInferenceCallsTable).values(rows),
  );
});

test("tierRecommendation covers every branch deterministically", () => {
  const base = { purpose: "segment_batch", calls: 200, validRate: 1, tiered: false };
  assert.equal(tierRecommendation(base).recommendation, "candidate");
  assert.equal(
    tierRecommendation({ ...base, calls: TIER_MIN_CALLS - 1 }).recommendation,
    "insufficient_data",
  );
  assert.equal(
    tierRecommendation({ ...base, validRate: 0.9 }).recommendation,
    "keep",
  );
  assert.equal(
    tierRecommendation({ ...base, purpose: "extract_invoice" }).recommendation,
    "keep",
  );
  assert.equal(
    tierRecommendation({ ...base, purpose: "eval_canary" }).recommendation,
    "keep",
  );
  assert.equal(
    tierRecommendation({ ...base, tiered: true }).recommendation,
    "tiered",
  );
  assert.equal(
    tierRecommendation({ ...base, tiered: true, validRate: 0.9 }).recommendation,
    "revert",
  );
});

test("the report joins ledger evidence with the tier map in force", async () => {
  const untiered = await computeTierReport();
  const probe = untiered.rows.find((r) => r.purpose === PURPOSE);
  assert.ok(probe, "the probe purpose appears in the report");
  assert.equal(probe.calls, TIER_MIN_CALLS + 1);
  assert.equal(probe.killedCount, 1);
  // killed is excluded from the validity denominator: 50 ok / 50 judged.
  assert.equal(probe.validRate, 1);
  assert.equal(probe.tiered, false);
  assert.equal(probe.currentModel, untiered.baseModel);
  assert.equal(probe.recommendation, "candidate");
  assert.equal(probe.totalTokens, TIER_MIN_CALLS * 110);
  // The probe's share of a busy shared ledger can round to 0.0000 — bounds
  // only, the absolute token count above is the precise assertion.
  assert.ok(probe.spendShare >= 0 && probe.spendShare <= 1);
  assert.ok(untiered.totalTokens >= probe.totalTokens);

  // With a tier configured for the probe purpose, the report shows the
  // routed model and flips the recommendation to the tiered branch.
  const saved = process.env.CLERK_MODEL_TIERS;
  process.env.CLERK_MODEL_TIERS = `${PURPOSE}=cheap-${SALT}`;
  try {
    const tiered = await computeTierReport();
    const row = tiered.rows.find((r) => r.purpose === PURPOSE);
    assert.ok(row);
    assert.equal(row.tiered, true);
    assert.equal(row.currentModel, `cheap-${SALT}`);
    assert.equal(row.recommendation, "tiered");
  } finally {
    if (saved === undefined) delete process.env.CLERK_MODEL_TIERS;
    else process.env.CLERK_MODEL_TIERS = saved;
  }
});
