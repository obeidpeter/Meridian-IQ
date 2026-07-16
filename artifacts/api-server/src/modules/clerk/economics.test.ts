import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getDb, firmsTable, clerkInferenceCallsTable } from "@workspace/db";
import { getClerkMetrics } from "./metrics.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Unit economics (idea #8). Pure SQL over the inference ledger — token spend
// per purpose inside the window and a per-month failure taxonomy — so the
// governance/pricing review can see where tokens go without any model call.
// The metrics are platform-wide (no firm filter), so the shared test DB is
// polluted by sibling suites; this test pins a purpose STRING unique to
// itself and asserts that purpose's row exactly, and uses >= for the global
// month taxonomy.

const SALT = makeRunSalt();
const firmId = randomUUID();
// A purpose value no other suite uses, so its aggregate row is ours alone.
const PROBE = `econ_probe_${SALT}`.slice(0, 40);

before(async () => {
  const db = getDb();
  await db.insert(firmsTable).values({ id: firmId, name: `Econ Firm ${SALT}` });
  // Three rows under the probe purpose: two ok + one error, all with usage.
  await db.insert(clerkInferenceCallsTable).values([
    {
      firmId,
      purpose: PROBE,
      model: "econ-model",
      promptVersion: "v1",
      inputRef: `econ-a-${SALT}`,
      outputJson: { chars: 1 },
      schemaValid: true,
      outcome: "ok",
      promptTokens: 1000,
      completionTokens: 200,
    },
    {
      firmId,
      purpose: PROBE,
      model: "econ-model",
      promptVersion: "v1",
      inputRef: `econ-b-${SALT}`,
      outputJson: null,
      schemaValid: false,
      outcome: "error",
      promptTokens: 500,
      completionTokens: 0,
    },
    {
      firmId,
      purpose: PROBE,
      model: "econ-model",
      promptVersion: "v1",
      inputRef: `econ-c-${SALT}`,
      outputJson: { chars: 1 },
      schemaValid: true,
      outcome: "ok",
      promptTokens: 300,
      completionTokens: 100,
    },
  ]);
});

// No after(): clerk_inference_calls is an append-only ledger (a trigger
// blocks deletes). The rows carry a purpose STRING and firm id unique to this
// run, so leaving them is harmless — the assertions never match sibling data.

test("economics.byPurpose totals tokens and errors per purpose in the window", async () => {
  const metrics = await getClerkMetrics(30);
  const probe = metrics.economics.byPurpose.find((p) => p.purpose === PROBE);
  assert.ok(probe, "the probe purpose is present");
  assert.equal(probe.calls, 3);
  assert.equal(probe.promptTokens, 1800);
  assert.equal(probe.completionTokens, 300);
  assert.equal(probe.errorCount, 1);
});

test("economics.byPurpose USD is null unless both per-token rates are configured", async () => {
  const savedIn = process.env.CLERK_COST_PER_1M_INPUT_USD;
  const savedOut = process.env.CLERK_COST_PER_1M_OUTPUT_USD;
  try {
    delete process.env.CLERK_COST_PER_1M_INPUT_USD;
    delete process.env.CLERK_COST_PER_1M_OUTPUT_USD;
    const bare = await getClerkMetrics(30);
    assert.equal(
      bare.economics.byPurpose.find((p) => p.purpose === PROBE)?.estimatedUsd,
      null,
    );

    process.env.CLERK_COST_PER_1M_INPUT_USD = "1";
    process.env.CLERK_COST_PER_1M_OUTPUT_USD = "2";
    const priced = await getClerkMetrics(30);
    const probe = priced.economics.byPurpose.find((p) => p.purpose === PROBE);
    // 1800 prompt @ $1/M + 300 completion @ $2/M = 0.0018 + 0.0006.
    assert.equal(probe?.estimatedUsd, 0.0024);
  } finally {
    if (savedIn === undefined) delete process.env.CLERK_COST_PER_1M_INPUT_USD;
    else process.env.CLERK_COST_PER_1M_INPUT_USD = savedIn;
    if (savedOut === undefined) delete process.env.CLERK_COST_PER_1M_OUTPUT_USD;
    else process.env.CLERK_COST_PER_1M_OUTPUT_USD = savedOut;
  }
});

test("economics.months carries the current month's outcome taxonomy", async () => {
  const metrics = await getClerkMetrics(30);
  assert.ok(metrics.economics.months.length >= 1);
  const currentMonth = new Date().toISOString().slice(0, 7);
  const row = metrics.economics.months.find((m) => m.month === currentMonth);
  assert.ok(row, "the current UTC month appears in the taxonomy");
  // Our three rows contribute at least 2 ok + 1 error (global count may hold
  // more from sibling suites).
  assert.ok(row.okCount >= 2);
  assert.ok(row.errorCount >= 1);
  assert.ok(row.calls >= 3);
});
