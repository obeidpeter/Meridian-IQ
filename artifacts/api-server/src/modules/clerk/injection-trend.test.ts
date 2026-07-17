import { test, before } from "node:test";
import assert from "node:assert/strict";
import { getDb, clerkEvalRunsTable } from "@workspace/db";
import { getClerkMetrics } from "./metrics.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Injection-resistance trend (round-6 idea #8): pure SQL over the stored
// eval runs. Pinned: the per-prompt-version split aggregates resisted over
// fixtures correctly, and the monthly buckets carry this month's runs.

const SALT = makeRunSalt();
const PROMPT_A = `trend.a.${SALT}`;
const PROMPT_B = `trend.b.${SALT}`;

before(async () => {
  await getDb()
    .insert(clerkEvalRunsTable)
    .values([
      {
        model: "fake-trend",
        promptVersion: PROMPT_A,
        fixtureCount: 6,
        fieldsCompared: 60,
        fieldsCorrect: 55,
        injectionFixtures: 4,
        injectionResisted: 4,
        results: [],
        durationMs: 100,
      },
      {
        model: "fake-trend",
        promptVersion: PROMPT_A,
        fixtureCount: 6,
        fieldsCompared: 60,
        fieldsCorrect: 54,
        injectionFixtures: 4,
        injectionResisted: 3,
        results: [],
        durationMs: 100,
      },
      {
        model: "fake-trend",
        promptVersion: PROMPT_B,
        fixtureCount: 6,
        fieldsCompared: 60,
        fieldsCorrect: 50,
        injectionFixtures: 4,
        injectionResisted: 2,
        results: [],
        durationMs: 100,
      },
    ]);
});

test("per-prompt-version resistance aggregates over fixtures, not runs", async () => {
  const metrics = await getClerkMetrics(30);
  const a = metrics.injectionTrend.byPromptVersion.find(
    (p) => p.promptVersion === PROMPT_A,
  );
  assert.ok(a, "prompt A appears (newest-first window of 10)");
  assert.equal(a.runs, 2);
  assert.equal(a.injectionFixtures, 8);
  assert.equal(a.injectionResisted, 7);
  assert.equal(a.resistanceRate, 0.875);

  const b = metrics.injectionTrend.byPromptVersion.find(
    (p) => p.promptVersion === PROMPT_B,
  );
  assert.equal(b?.resistanceRate, 0.5);
});

test("monthly buckets include this month's runs", async () => {
  const metrics = await getClerkMetrics(30);
  const thisMonth = new Date().toISOString().slice(0, 7);
  const bucket = metrics.injectionTrend.months.find(
    (m) => m.month === thisMonth,
  );
  assert.ok(bucket, "the current month is bucketed");
  assert.ok(bucket.runs >= 3, "our three runs are counted");
  assert.ok(bucket.injectionFixtures >= 12);
  assert.ok(
    bucket.resistanceRate >= 0 && bucket.resistanceRate <= 1,
    "rate is a proportion",
  );
});
