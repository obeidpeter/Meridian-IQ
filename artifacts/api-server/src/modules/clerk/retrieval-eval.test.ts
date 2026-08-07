import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  clerkInferenceCallsTable,
  clerkRetrievalEvalRunsTable,
  EMBEDDING_DIMS,
} from "@workspace/db";
import type { MemoryEmbedder } from "./gateway.ts";
import {
  RETRIEVAL_DOCS,
  RETRIEVAL_EVAL_PROMPT_VERSION,
  RETRIEVAL_K,
  RETRIEVAL_QUERIES,
  detectRetrievalQualityDrop,
  listRetrievalEvalRuns,
  runRetrievalEval,
  scoreRetrieval,
  sweepRetrievalWatch,
  type RetrievalWatchRun,
} from "./retrieval-eval.ts";
import {
  restoreClerkFlag,
  saveAndEnableClerkFlag,
} from "./test-support.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Retrieval eval lane (round 47): the scorer is DETERMINISTIC app code over
// whatever vectors the embedder returned — these tests drive it with
// crafted geometry so every rank is known in advance, then pin:
//  - recall@k and MRR arithmetic (including a deliberate miss);
//  - the run row's shape and its PLATFORM-funded (firmId null) ledger row
//    under the eval_retrieval purpose;
//  - drop detection against the trailing baseline (recall wins ties);
//  - the audit-ledger alert dedup (one alert per degraded run).

const SALT = makeRunSalt();

function axis(i: number): number[] {
  const v = new Array<number>(EMBEDDING_DIMS).fill(0);
  v[i] = 1;
  return v;
}

// Perfect geometry: doc i gets axis(i); every query gets its expected doc's
// axis → every rank is 1.
function perfectEmbedder(): MemoryEmbedder & { calls: number } {
  const docAxis = new Map(RETRIEVAL_DOCS.map((d, i) => [d.key, i]));
  const byText = new Map<string, number[]>();
  RETRIEVAL_DOCS.forEach((d, i) => byText.set(d.text, axis(i)));
  RETRIEVAL_QUERIES.forEach((q) =>
    byText.set(q.text, axis(docAxis.get(q.expectedDoc)!)),
  );
  const embedder = {
    model: `fake-retrieval-${SALT}`,
    calls: 0,
    async embed(texts: string[]) {
      embedder.calls += 1;
      return {
        vectors: texts.map((t) => byText.get(t) ?? axis(EMBEDDING_DIMS - 1)),
        promptTokens: texts.length,
      };
    },
  };
  return embedder;
}

before(async () => {
  await saveAndEnableClerkFlag();
});

after(async () => {
  await restoreClerkFlag();
});

test("scoreRetrieval: known geometry scores exactly", () => {
  // Start from the perfect assignment, then degrade two queries: q[1]'s
  // expected doc is pushed to rank 2, q[2]'s to rank 4 (a miss at k=3).
  const docAxis = new Map(RETRIEVAL_DOCS.map((d, i) => [d.key, i]));
  const vectors: number[][] = [
    ...RETRIEVAL_DOCS.map((_, i) => axis(i)),
    ...RETRIEVAL_QUERIES.map((q) => axis(docAxis.get(q.expectedDoc)!)),
  ];
  const q1 = RETRIEVAL_QUERIES[1];
  const q2 = RETRIEVAL_QUERIES[2];
  // q1: strongest on some OTHER doc, expected doc second.
  const q1v = new Array<number>(EMBEDDING_DIMS).fill(0);
  q1v[docAxis.get(q1.expectedDoc)!] = 0.6;
  q1v[11] = 0.8;
  vectors[RETRIEVAL_DOCS.length + 1] = q1v;
  // q2: three other docs rank above the expected one.
  const q2v = new Array<number>(EMBEDDING_DIMS).fill(0);
  q2v[docAxis.get(q2.expectedDoc)!] = 0.3;
  q2v[9] = 0.9;
  q2v[10] = 0.8;
  q2v[11] = 0.7;
  vectors[RETRIEVAL_DOCS.length + 2] = q2v;

  const { results, hits, mrr } = scoreRetrieval(vectors);
  assert.equal(results.length, RETRIEVAL_QUERIES.length);
  assert.equal(results[0].rank, 1);
  assert.equal(results[1].rank, 2);
  assert.equal(results[1].hit, true, "rank 2 is within k=3");
  assert.equal(results[2].rank, 4);
  assert.equal(results[2].hit, false, "rank 4 misses k=3");
  assert.equal(hits, RETRIEVAL_QUERIES.length - 1);
  const expectedMrr =
    (RETRIEVAL_QUERIES.length - 2 + 1 / 2 + 1 / 4) / RETRIEVAL_QUERIES.length;
  assert.equal(mrr, Number(expectedMrr.toFixed(4)));
});

test("runRetrievalEval: one platform-funded embed call, stored run row", async () => {
  const embedder = perfectEmbedder();
  const run = await runRetrievalEval(null, embedder);
  assert.equal(embedder.calls, 1, "the whole corpus embeds in ONE call");
  assert.equal(run.model, embedder.model);
  assert.equal(run.promptVersion, RETRIEVAL_EVAL_PROMPT_VERSION);
  assert.equal(run.k, RETRIEVAL_K);
  assert.equal(run.fixtureCount, RETRIEVAL_QUERIES.length);
  assert.equal(run.hits, RETRIEVAL_QUERIES.length, "perfect geometry");
  assert.equal(run.mrr, 1);
  assert.equal(run.startedBy, null, "sweep-style run");
  assert.equal(run.results.length, RETRIEVAL_QUERIES.length);

  const [stored] = await runInBypassContext(() =>
    getDb()
      .select()
      .from(clerkRetrievalEvalRunsTable)
      .where(eq(clerkRetrievalEvalRunsTable.id, run.id)),
  );
  assert.ok(stored, "run row durably stored");
  // The health card's list source (round 48): newest first, our run leads.
  const listed = await runInBypassContext(() => listRetrievalEvalRuns());
  assert.equal(listed[0]?.id, run.id, "the list serves the newest run first");

  const [ledger] = await runInBypassContext(() =>
    getDb()
      .select({
        firmId: clerkInferenceCallsTable.firmId,
        promptTokens: clerkInferenceCallsTable.promptTokens,
      })
      .from(clerkInferenceCallsTable)
      .where(
        and(
          eq(clerkInferenceCallsTable.purpose, "eval_retrieval"),
          eq(
            clerkInferenceCallsTable.promptVersion,
            RETRIEVAL_EVAL_PROMPT_VERSION,
          ),
          eq(clerkInferenceCallsTable.model, embedder.model),
        ),
      )
      .orderBy(desc(clerkInferenceCallsTable.createdAt))
      .limit(1),
  );
  assert.ok(ledger, "eval embed ledgered under its own purpose");
  assert.equal(ledger.firmId, null, "platform-funded: no firm charged");
  assert.equal(
    ledger.promptTokens,
    RETRIEVAL_DOCS.length + RETRIEVAL_QUERIES.length,
    "spend recorded",
  );
});

test("detectRetrievalQualityDrop: trailing baseline, recall wins, quiet below minimum", () => {
  const mk = (
    id: string,
    hits: number,
    mrr: number,
    fixtureCount = 10,
  ): RetrievalWatchRun => ({ id, fixtureCount, hits, mrr });

  // Too little history: quiet.
  assert.equal(
    detectRetrievalQualityDrop([mk("n", 5, 0.5), mk("a", 10, 1)]),
    null,
  );

  const baseline = [
    mk("b1", 9, 0.9),
    mk("b2", 10, 0.95),
    mk("b3", 9, 0.92),
  ];
  // No material drop: quiet.
  assert.equal(
    detectRetrievalQualityDrop([mk("ok", 9, 0.9), ...baseline]),
    null,
  );
  // Recall drop (0.93 baseline → 0.5): reported, recall preferred.
  const drop = detectRetrievalQualityDrop([mk("bad", 5, 0.5), ...baseline]);
  assert.ok(drop);
  assert.equal(drop.metric, "recall");
  assert.equal(drop.newestRunId, "bad");
  // MRR-only drop (recall held): the mrr metric reports.
  const mrrDrop = detectRetrievalQualityDrop([
    mk("mrr-bad", 9, 0.5),
    ...baseline,
  ]);
  assert.ok(mrrDrop);
  assert.equal(mrrDrop.metric, "mrr");
});

test("sweepRetrievalWatch: alerts once per degraded run, dedups on re-check", async () => {
  const degradedId = randomUUID();
  const runs: RetrievalWatchRun[] = [
    { id: degradedId, fixtureCount: 10, hits: 3, mrr: 0.3 },
    { id: randomUUID(), fixtureCount: 10, hits: 10, mrr: 1 },
    { id: randomUUID(), fixtureCount: 10, hits: 9, mrr: 0.95 },
    { id: randomUUID(), fixtureCount: 10, hits: 10, mrr: 0.97 },
  ];
  const deps = { runs: async () => runs };
  const first = await sweepRetrievalWatch(deps);
  assert.deepEqual(first, { checked: true, dropped: true, alerted: true });
  const second = await sweepRetrievalWatch(deps);
  assert.deepEqual(
    second,
    { checked: true, dropped: true, alerted: false },
    "the durable audit ledger dedups the alert",
  );
});
