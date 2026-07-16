import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  getDb,
  firmsTable,
  partiesTable,
  invoicesTable,
  usersTable,
  clerkCasesTable,
  clerkInferenceCallsTable,
} from "@workspace/db";
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

// clerk_inference_calls is an append-only ledger (a trigger blocks deletes),
// and its rows carry a PROBE purpose + firm id unique to this run, so they are
// harmless to leave. The supplierAccuracy probe DOES need cleanup: it inserts
// a clerk_cases row (top-20 by override count), and on a reused dev DB many
// such rows would eventually crowd the current run's out of the LIMIT window
// and flake the assertion. clerk_cases has no append-only trigger, so delete
// this run's case (unique firm id) after the suite.
after(async () => {
  await getDb()
    .delete(clerkCasesTable)
    .where(eq(clerkCasesTable.firmId, firmId));
});

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

test("supplierAccuracy groups the corrections exhaust by register supplier", async () => {
  const db = getDb();
  const supplierId = randomUUID();
  const userId = randomUUID();
  const invoiceId = randomUUID();
  const SUPPLIER = `Econ Supplier ${SALT}`;
  await db
    .insert(usersTable)
    .values({ id: userId, email: `econ-${SALT}@test.example` })
    .onConflictDoNothing();
  await db.insert(partiesTable).values([
    { id: supplierId, type: "client_business", legalName: SUPPLIER },
  ]);
  await db.insert(invoicesTable).values({
    id: invoiceId,
    firmId,
    supplierPartyId: supplierId,
    buyerPartyId: supplierId,
    invoiceNumber: `ECON-${SALT}`,
    issueDate: "2026-07-01",
  });
  // One approved case whose corrections show 39 of 40 fields overridden.
  // The table is top-20 by overridden count and the shared test DB
  // accumulates corrected approvals from every suite, so the probe carries a
  // deliberately dominant override count to stay inside the window — the
  // assertions below still pin exact per-supplier arithmetic.
  await db.insert(clerkCasesTable).values({
    kind: "extraction",
    status: "approved",
    sourceType: "text",
    sourceName: `econ-${SALT}.txt`,
    firmId,
    createdBy: userId,
    createdInvoiceId: invoiceId,
    corrections: [
      { field: "invoiceNumber", extracted: "A", final: "A", changed: false },
      ...Array.from({ length: 39 }, (_, i) => ({
        field: `probe.${i}`,
        extracted: "1",
        final: "2",
        changed: true,
      })),
    ],
  });

  const metrics = await getClerkMetrics(30);
  const rowFor = metrics.supplierAccuracy.find(
    (s) => s.supplierName === SUPPLIER,
  );
  assert.ok(rowFor, "the supplier appears in the accuracy table");
  assert.equal(rowFor.cases, 1);
  assert.equal(rowFor.fieldsCompared, 40);
  assert.equal(rowFor.overridden, 39);
  assert.equal(rowFor.overrideRate, 0.975);
  assert.equal(rowFor.firmName, `Econ Firm ${SALT}`);
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
