import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  clerkCasesTable,
  clerkInferenceCallsTable,
  clerkMemoryEmbeddingsTable,
  featureFlagsTable,
  firmsTable,
  usersTable,
  EMBEDDING_DIMS,
} from "@workspace/db";
import { embedWithLedger, type MemoryEmbedder } from "./gateway.ts";
import {
  EMBED_PROMPT_VERSION,
  MEMORY_FLAG_KEY,
  indexMemoryBatch,
  memoryRailReady,
  searchMemory,
} from "./memory.ts";
import {
  restoreClerkFlag,
  saveAndEnableClerkFlag,
} from "./test-support.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// pgvector firm memory Phase 1: the embedding rail. What matters here:
//  - the indexer is INCREMENTAL (the anti-join re-offers nothing already
//    indexed under the current model) and per-firm budgeted;
//  - every embedding call lands a ledger row that charges prompt_tokens —
//    except a budget-exhausted firm, which is skipped with NO row (no call
//    left the platform);
//  - a mis-sized embedding response is discarded whole, never stored;
//  - search is firm-isolated, model-pinned and similarity-floored;
//  - the rail is dark without its flags.
// The embedder is a deterministic fake — no live model calls, the gateway
// injection seam exactly as infer() uses it.

const SALT = makeRunSalt();

const firmA = randomUUID();
const firmB = randomUUID();
const firmBudget = randomUUID(); // budget-exhausted firm
const userId = randomUUID();
const vatCase = randomUUID(); // firm A, "vat" question
const payeCase = randomUUID(); // firm A, "payroll" question
const bCase = randomUUID(); // firm B
const budgetCase = randomUUID(); // firmBudget

// Deterministic embedding geometry: three orthogonal base vectors padded to
// the platform width, keyed off the question text.
function baseVector(first: number, second: number, third: number): number[] {
  const v = new Array<number>(EMBEDDING_DIMS).fill(0);
  v[0] = first;
  v[1] = second;
  v[2] = third;
  return v;
}
const VAT_VECTOR = baseVector(1, 0, 0);
const PAYE_VECTOR = baseVector(0, 1, 0);
const OTHER_VECTOR = baseVector(0, 0, 1);

function fakeEmbedder(): MemoryEmbedder & { calls: number } {
  const embedder = {
    model: `fake-embed-${SALT}`,
    calls: 0,
    async embed(texts: string[]) {
      embedder.calls += 1;
      return {
        vectors: texts.map((t) =>
          t.includes("VAT") ? VAT_VECTOR : t.includes("payroll") ? PAYE_VECTOR : OTHER_VECTOR,
        ),
        promptTokens: 42,
      };
    },
  };
  return embedder;
}

before(async () => {
  await saveAndEnableClerkFlag();
  // The indexer's per-firm wall consults the override-aware flag, which
  // falls back to the GLOBAL clerk_memory row — light it for the suite
  // (production only reaches the indexer with it lit); the flag-gating
  // test toggles it itself and the after() hook re-darkens it.
  await runInBypassContext(async () => {
    await getDb()
      .insert(featureFlagsTable)
      .values({ key: MEMORY_FLAG_KEY, enabled: true, releaseTag: "R3" })
      .onConflictDoUpdate({
        target: featureFlagsTable.key,
        set: { enabled: true },
      });
  });
  const db = getDb();
  await db.insert(firmsTable).values([
    { id: firmA, name: `Memory Firm A ${SALT}` },
    { id: firmB, name: `Memory Firm B ${SALT}` },
    { id: firmBudget, name: `Memory Firm C ${SALT}` },
  ]);
  await db
    .insert(usersTable)
    .values({ id: userId, email: `memory-${SALT}@test.local` })
    .onConflictDoNothing();
  const answer = { answered: true, proposition: `answered ${SALT}`, facts: [] };
  await db.insert(clerkCasesTable).values([
    {
      id: vatCase,
      firmId: firmA,
      kind: "question",
      status: "approved",
      createdBy: userId,
      question: `What is our VAT position this month? ${SALT}`,
      answer,
    },
    {
      id: payeCase,
      firmId: firmA,
      kind: "question",
      status: "approved",
      createdBy: userId,
      question: `When is payroll tax due? ${SALT}`,
      answer,
    },
    {
      id: bCase,
      firmId: firmB,
      kind: "question",
      status: "approved",
      createdBy: userId,
      question: `What is our VAT position? (other firm) ${SALT}`,
      answer,
    },
    {
      id: budgetCase,
      firmId: firmBudget,
      kind: "question",
      status: "approved",
      createdBy: userId,
      question: `Anything overdue? ${SALT}`,
      answer,
    },
  ]);
  // Exhaust firmBudget's monthly allowance before the indexer reaches it:
  // one giant already-ledgered call this month.
  await db.insert(clerkInferenceCallsTable).values({
    firmId: firmBudget,
    purpose: "classify_intent",
    model: "test",
    promptVersion: "test",
    inputRef: "test",
    outputJson: null,
    schemaValid: true,
    outcome: "ok",
    promptTokens: 100_000_000,
    completionTokens: 0,
  });
});

after(async () => {
  await runInBypassContext(async () => {
    await getDb()
      .update(featureFlagsTable)
      .set({ enabled: false })
      .where(eq(featureFlagsTable.key, MEMORY_FLAG_KEY));
  });
  await restoreClerkFlag();
});

const OUR_FIRMS = [firmA, firmB, firmBudget];

test("the indexer embeds resolved questions per firm, charges the ledger, and is incremental", async () => {
  const embedder = fakeEmbedder();
  // Pinned to this suite's own salted firms: the indexer must not drain —
  // or spend against — other suites' candidates in the shared scratch DB.
  const first = await indexMemoryBatch(embedder, 50, { onlyFirmIds: OUR_FIRMS });
  assert.equal(first.indexed, 3, "exactly our three in-budget cases indexed");
  assert.equal(first.skippedFirms, 1, "exactly the exhausted firm skipped");

  const rows = await runInBypassContext(() =>
    getDb()
      .select()
      .from(clerkMemoryEmbeddingsTable)
      .where(eq(clerkMemoryEmbeddingsTable.firmId, firmA)),
  );
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.corpus, "ask_questions");
    assert.equal(row.model, embedder.model);
    assert.equal(row.embedding.length, EMBEDDING_DIMS);
  }

  // The ledger charged the spend: one ok embed row per indexed firm, with
  // prompt tokens populated (the budget sums this column).
  const ledger = await runInBypassContext(() =>
    getDb()
      .select()
      .from(clerkInferenceCallsTable)
      .where(
        and(
          eq(clerkInferenceCallsTable.firmId, firmA),
          eq(clerkInferenceCallsTable.purpose, "embed_memory"),
        ),
      ),
  );
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].outcome, "ok");
  assert.equal(ledger[0].promptTokens, 42);
  assert.equal(ledger[0].promptVersion, EMBED_PROMPT_VERSION);

  // Incremental: a second pass finds nothing for the same model, and the
  // provider is never touched.
  const callsBefore = embedder.calls;
  const second = await indexMemoryBatch(embedder, 50, {
    onlyFirmIds: OUR_FIRMS,
  });
  assert.equal(second.indexed, 0, "anti-join re-offers nothing");
  assert.equal(embedder.calls, callsBefore, "no provider call on a no-op pass");
  const oursAgain = await runInBypassContext(() =>
    getDb()
      .select({ n: sql<number>`count(*)::int` })
      .from(clerkMemoryEmbeddingsTable)
      .where(eq(clerkMemoryEmbeddingsTable.firmId, firmA)),
  );
  assert.equal(Number(oursAgain[0]?.n), 2, "no duplicate rows");
});

test("a per-firm flag override darkens ONE firm's indexing without a ledger row", async () => {
  const { featureFlagOverridesTable } = await import("@workspace/db");
  await runInBypassContext(async () => {
    await getDb()
      .insert(featureFlagOverridesTable)
      .values({ flagKey: "clerk_ai", firmId: firmB, enabled: false })
      .onConflictDoNothing();
  });
  try {
    // Force firm B back into the candidate pool under a NEW model so the
    // anti-join offers it again.
    const embedder = fakeEmbedder();
    embedder.model = `fake-embed-override-${SALT}`;
    const result = await indexMemoryBatch(embedder, 50, {
      onlyFirmIds: [firmB],
    });
    assert.equal(result.indexed, 0);
    assert.equal(result.skippedFirms, 1, "the overridden firm is skipped");
    assert.equal(embedder.calls, 0, "no call left the platform");
  } finally {
    await runInBypassContext(async () => {
      await getDb()
        .delete(featureFlagOverridesTable)
        .where(
          and(
            eq(featureFlagOverridesTable.flagKey, "clerk_ai"),
            eq(featureFlagOverridesTable.firmId, firmB),
          ),
        );
    });
  }
});

test("a model change re-indexes through the conflict-update path", async () => {
  const embedder = fakeEmbedder();
  embedder.model = `fake-embed-v2-${SALT}`;
  const result = await indexMemoryBatch(embedder, 50, {
    onlyFirmIds: [firmA],
  });
  assert.equal(result.indexed, 2, "both firm A rows re-offered for the new model");
  const rows = await runInBypassContext(() =>
    getDb()
      .select()
      .from(clerkMemoryEmbeddingsTable)
      .where(eq(clerkMemoryEmbeddingsTable.firmId, firmA)),
  );
  assert.equal(rows.length, 2, "updated in place, never duplicated");
  for (const row of rows) {
    assert.equal(row.model, embedder.model);
  }
  // Restore the original model so the search test's pin still matches.
  const original = fakeEmbedder();
  const back = await indexMemoryBatch(original, 50, { onlyFirmIds: [firmA] });
  assert.equal(back.indexed, 2);
});

test("the exhausted firm was skipped with NO ledger row — no call left the platform", async () => {
  const memoryRows = await runInBypassContext(() =>
    getDb()
      .select()
      .from(clerkMemoryEmbeddingsTable)
      .where(eq(clerkMemoryEmbeddingsTable.firmId, firmBudget)),
  );
  assert.equal(memoryRows.length, 0);
  const embedLedger = await runInBypassContext(() =>
    getDb()
      .select()
      .from(clerkInferenceCallsTable)
      .where(
        and(
          eq(clerkInferenceCallsTable.firmId, firmBudget),
          eq(clerkInferenceCallsTable.purpose, "embed_memory"),
        ),
      ),
  );
  assert.equal(embedLedger.length, 0, "budget refusal writes no ledger row");
});

test("search is firm-isolated, model-pinned, ranked and floored", async () => {
  const embedder = fakeEmbedder();
  // A query pointing mostly at the VAT direction.
  const query = baseVector(1, 0.2, 0);
  // Under the caller's own FIRM SCOPE (not bypass): the RLS policy must
  // admit the firm's own rows — the posture every retrieval surface runs in.
  const { inClerkScope } = await import("./scope.ts");
  const matches = await inClerkScope(firmA, () =>
    searchMemory({
      firmId: firmA,
      corpus: "ask_questions",
      model: embedder.model,
      vector: query,
      k: 5,
    }),
  );
  assert.equal(matches.length, 2, "only firm A's rows");
  assert.equal(matches[0].refId, vatCase, "nearest first");
  assert.ok(matches[0].similarity > matches[1].similarity);
  assert.ok(!matches.some((m) => m.refId === bCase), "no cross-firm leak");

  const otherModel = await runInBypassContext(() =>
    searchMemory({
      firmId: firmA,
      corpus: "ask_questions",
      model: "some-other-model",
      vector: query,
      k: 5,
    }),
  );
  assert.equal(otherModel.length, 0, "model-pinned: no mixed-model matches");

  const floored = await runInBypassContext(() =>
    searchMemory({
      firmId: firmA,
      corpus: "ask_questions",
      model: embedder.model,
      vector: OTHER_VECTOR,
      k: 5,
      minSimilarity: 0.9,
    }),
  );
  assert.equal(floored.length, 0, "an unrelated query returns nothing");
});

test("a mis-sized embedding response is discarded whole", async () => {
  const badEmbedder: MemoryEmbedder = {
    model: `bad-embed-${SALT}`,
    async embed(texts: string[]) {
      return { vectors: texts.map(() => [1, 2, 3]), promptTokens: 7 };
    },
  };
  const result = await embedWithLedger(badEmbedder, {
    firmId: firmA,
    texts: ["anything"],
    promptVersion: EMBED_PROMPT_VERSION,
    dims: EMBEDDING_DIMS,
  });
  assert.equal(result.ok, false);
  const ledger = await runInBypassContext(() =>
    getDb()
      .select()
      .from(clerkInferenceCallsTable)
      .where(
        and(
          eq(clerkInferenceCallsTable.firmId, firmA),
          eq(clerkInferenceCallsTable.model, badEmbedder.model),
        ),
      ),
  );
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].outcome, "invalid_discarded");
  assert.equal(ledger[0].promptTokens, 7, "the spend is still recorded");
});

test("the rail is dark without the clerk_memory flag and lights with it", async () => {
  // clerk_ai is on (before hook); clerk_memory has never been enabled here.
  await runInBypassContext(async () => {
    await getDb()
      .insert(featureFlagsTable)
      .values({ key: MEMORY_FLAG_KEY, enabled: false, releaseTag: "R3" })
      .onConflictDoUpdate({
        target: featureFlagsTable.key,
        set: { enabled: false },
      });
  });
  assert.equal(await memoryRailReady(), false, "dark by default");
  await runInBypassContext(async () => {
    await getDb()
      .update(featureFlagsTable)
      .set({ enabled: true })
      .where(eq(featureFlagsTable.key, MEMORY_FLAG_KEY));
  });
  assert.equal(
    await memoryRailReady(),
    true,
    "flags lit + extension present = ready",
  );
  await runInBypassContext(async () => {
    await getDb()
      .update(featureFlagsTable)
      .set({ enabled: false })
      .where(eq(featureFlagsTable.key, MEMORY_FLAG_KEY));
  });
});
