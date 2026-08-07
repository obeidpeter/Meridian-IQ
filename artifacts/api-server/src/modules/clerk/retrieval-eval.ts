import { desc, isNull, sql } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  clerkRetrievalEvalRunsTable,
  EMBEDDING_DIMS,
  type ClerkRetrievalEvalRun,
  type RetrievalEvalFixtureResult,
} from "@workspace/db";
import { registerSweep } from "../pipeline/pipeline";
import { logger } from "../../lib/logger";
import { isFeatureEnabled } from "../flags/flags";
import { CLERK_FLAG_KEY, embedWithLedger, type MemoryEmbedder } from "./gateway";
import { embedderOrNull } from "./provider";
import {
  alertOnceViaAuditLedger,
  atMostHourly,
  envThreshold,
} from "./watch-shared";

// Retrieval eval lane (round 47, Phase 3): does the LIVE embedding model
// still rank the right memory first? The memory rail's SQL is exact and
// deterministic (searchMemory has its own tests), so what can silently
// degrade is the MODEL — a provider-side change, a re-pointed
// CLERK_EMBEDDING_MODEL, a quality regression. This lane measures exactly
// that and nothing else:
//  - a FIXED labeled corpus (documents phrased like the real ask_questions
//    corpus, queries phrased like real follow-ups, each labeled with the
//    one document it should find);
//  - ONE platform-funded embedding call per run (firmId null — the corpus
//    belongs to no tenant; purpose eval_retrieval keeps its spend cohort
//    apart from firm memory);
//  - a DETERMINISTIC in-process scorer — cosine over the returned vectors,
//    recall@k and MRR against the labels; no model judges anything, and
//    the real clerk_memory_embeddings index is never touched;
//  - the phrasing lane's operational shape verbatim: bypass-only run table
//    (migration 0040), opt-in nightly sweep, trailing-baseline drop watch
//    with a durable once-only audit alert.

export const RETRIEVAL_EVAL_PROMPT_VERSION = "retrieval-eval.v1";
export const RETRIEVAL_K = 3;

interface RetrievalDoc {
  key: string;
  text: string;
}

interface RetrievalQuery {
  key: string;
  text: string;
  expectedDoc: string;
}

// The labeled corpus. Documents read like the stored side (a firm's past
// Ask questions); queries read like the incoming side (the same need,
// re-phrased). Growing it is append-only — the drop watch compares RATES,
// so adding fixtures never reads as a regression.
export const RETRIEVAL_DOCS: RetrievalDoc[] = [
  { key: "vat_due", text: "When is our VAT return for May due and what happens if we file it late?" },
  { key: "paye_remit", text: "How do I remit PAYE for our staff for last month?" },
  { key: "wht_credit", text: "Can we use withholding tax credit notes against our VAT bill?" },
  { key: "invoice_reject_tin", text: "Why was our invoice rejected with a TIN mismatch error?" },
  { key: "buyer_unpaid", text: "Which buyers still have not paid us for June?" },
  { key: "stamp_verify", text: "How can a customer verify the FIRS stamp on an invoice we sent them?" },
  { key: "recon_missing", text: "Our bank statement shows money in that has no matching invoice — what should we do?" },
  { key: "penalty_est", text: "Roughly what penalties do we owe on the two overdue filings?" },
  { key: "cash_outlook", text: "How much cash should we expect to come in over the next month?" },
  { key: "onboard_status", text: "How far along is the onboarding for our new client?" },
  { key: "chase_ladder", text: "What reminder steps does the platform take before an unpaid invoice is escalated?" },
  { key: "close_month", text: "What is left to do before we can close the books for July?" },
];

export const RETRIEVAL_QUERIES: RetrievalQuery[] = [
  { key: "q_vat_deadline", text: "what's the deadline for the May VAT filing?", expectedDoc: "vat_due" },
  { key: "q_paye", text: "paying employee PAYE for June — how does it work?", expectedDoc: "paye_remit" },
  { key: "q_wht", text: "offsetting WHT credit notes against VAT owed", expectedDoc: "wht_credit" },
  { key: "q_tin", text: "invoice bounced with a TIN mismatch", expectedDoc: "invoice_reject_tin" },
  { key: "q_owed", text: "who still owes us money from last month?", expectedDoc: "buyer_unpaid" },
  { key: "q_verify", text: "a customer wants to check our invoice stamp is genuine", expectedDoc: "stamp_verify" },
  { key: "q_credit", text: "there's an unexplained credit on the bank statement", expectedDoc: "recon_missing" },
  { key: "q_penalty", text: "how big is the fine for the late returns?", expectedDoc: "penalty_est" },
  { key: "q_inflow", text: "expected receipts over the coming weeks", expectedDoc: "cash_outlook" },
  { key: "q_close", text: "what month-end close steps remain?", expectedDoc: "close_month" },
];

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// Pure scorer, exported for tests: `vectors` is the embedding of
// [...RETRIEVAL_DOCS, ...RETRIEVAL_QUERIES] texts IN THAT ORDER (the exact
// batch runRetrievalEval sends). For each query: rank every document by
// cosine (ties broken by document order, deterministic), find the expected
// document's 1-based rank, hit = rank <= k. MRR sums 1/rank over the FULL
// ordering — a poorly-ranked fixture still contributes signal instead of
// flattening to the recall cliff.
export function scoreRetrieval(
  vectors: number[][],
  k = RETRIEVAL_K,
): { results: RetrievalEvalFixtureResult[]; hits: number; mrr: number } {
  const docVectors = RETRIEVAL_DOCS.map((d, i) => ({
    key: d.key,
    vector: vectors[i],
  }));
  const queryVectors = RETRIEVAL_QUERIES.map((q, i) => ({
    query: q,
    vector: vectors[RETRIEVAL_DOCS.length + i],
  }));
  const results: RetrievalEvalFixtureResult[] = queryVectors.map(
    ({ query, vector }) => {
      const ranked = docVectors
        .map((d, i) => {
          // Standalone safety: a NaN cosine (degenerate input) would fall
          // through the sort comparator to the index tiebreak and READ AS
          // a hit for early docs — pin it to the bottom instead. Not
          // reachable via runRetrievalEval (embedWithLedger discards
          // non-finite vectors), but the scorer is exported.
          const raw = cosine(vector, d.vector);
          return { key: d.key, sim: Number.isFinite(raw) ? raw : -Infinity, i };
        })
        .sort((a, b) => b.sim - a.sim || a.i - b.i);
      const idx = ranked.findIndex((r) => r.key === query.expectedDoc);
      const rank = idx === -1 ? null : idx + 1;
      return {
        key: query.key,
        expectedDoc: query.expectedDoc,
        rank,
        hit: rank !== null && rank <= k,
      };
    },
  );
  const hits = results.filter((r) => r.hit).length;
  const mrr =
    results.length === 0
      ? 0
      : results.reduce((acc, r) => acc + (r.rank ? 1 / r.rank : 0), 0) /
        results.length;
  return { results, hits, mrr: Number(mrr.toFixed(4)) };
}

// One run: embed the whole labeled corpus with the live embedder (ONE
// platform-funded call), score deterministically, store the run row under
// bypass (the 0040 posture). Throws on an embed refusal — the sweep's
// catch turns that into a quiet skip, and a future on-demand route would
// surface it as the provider error it is.
export async function runRetrievalEval(
  startedBy: string | null,
  embedder: MemoryEmbedder,
): Promise<ClerkRetrievalEvalRun> {
  const startedAt = Date.now();
  const texts = [
    ...RETRIEVAL_DOCS.map((d) => d.text),
    ...RETRIEVAL_QUERIES.map((q) => q.text),
  ];
  const embedded = await embedWithLedger(embedder, {
    firmId: null,
    purpose: "eval_retrieval",
    texts,
    promptVersion: RETRIEVAL_EVAL_PROMPT_VERSION,
    dims: EMBEDDING_DIMS,
  });
  if (!embedded.ok) {
    throw new Error(`Retrieval eval embedding failed: ${embedded.message}`);
  }
  const { results, hits, mrr } = scoreRetrieval(embedded.vectors);
  const [run] = await runInBypassContext(() =>
    getDb()
      .insert(clerkRetrievalEvalRunsTable)
      .values({
        startedBy,
        model: embedded.model,
        promptVersion: RETRIEVAL_EVAL_PROMPT_VERSION,
        k: RETRIEVAL_K,
        fixtureCount: RETRIEVAL_QUERIES.length,
        hits,
        mrr,
        results,
        durationMs: Date.now() - startedAt,
      })
      .returning(),
  );
  return run;
}

// Newest first, capped — the health card's trend material (the phrasing
// list's shape). Callers are operator-bypass requests or tests; the table
// is bypass-only (0040).
export async function listRetrievalEvalRuns(): Promise<
  ClerkRetrievalEvalRun[]
> {
  return getDb()
    .select()
    .from(clerkRetrievalEvalRunsTable)
    .orderBy(
      desc(clerkRetrievalEvalRunsTable.createdAt),
      desc(clerkRetrievalEvalRunsTable.id),
    )
    .limit(20);
}

// ---- Nightly sweep (the phrasing-watch shape verbatim) ----------------------

const AUTO_RETRIEVAL_FLAG_KEY = "clerk_auto_retrieval_eval";
// Fresh advisory lock id (731_850 memory indexer; see the catalogue comment
// in memory.ts).
const RETRIEVAL_SWEEP_LOCK_ID = 731_851;

async function autoRetrievalDueToday(): Promise<boolean> {
  const [last] = await getDb()
    .select({ createdAt: clerkRetrievalEvalRunsTable.createdAt })
    .from(clerkRetrievalEvalRunsTable)
    .where(isNull(clerkRetrievalEvalRunsTable.startedBy))
    .orderBy(desc(clerkRetrievalEvalRunsTable.createdAt))
    .limit(1);
  if (!last) return true;
  const today = new Date().toISOString().slice(0, 10);
  return last.createdAt.toISOString().slice(0, 10) !== today;
}

registerSweep(async function sweepRetrievalAutoEval(): Promise<void> {
  const due = await runInBypassContext(async () => {
    const [{ locked }] = (
      await getDb().execute<{ locked: boolean }>(
        sql`SELECT pg_try_advisory_xact_lock(${RETRIEVAL_SWEEP_LOCK_ID}) AS locked`,
      )
    ).rows;
    if (!locked) return false;
    // Each run spends platform tokens: opt-in flag, at most once per UTC
    // day, and the kill switch checked here too (the phrasing-watch M2
    // rationale — a dark clerk_ai must not redden sweep health all day).
    if (!(await isFeatureEnabled(CLERK_FLAG_KEY))) return false;
    if (!(await isFeatureEnabled(AUTO_RETRIEVAL_FLAG_KEY))) return false;
    return autoRetrievalDueToday();
  });
  if (!due) return;
  try {
    const embedder = await embedderOrNull();
    if (!embedder) return;
    const run = await runRetrievalEval(null, embedder);
    logger.info(
      { fixtureCount: run.fixtureCount, hits: run.hits, mrr: run.mrr },
      "retrieval lane: nightly eval run complete",
    );
  } catch (err) {
    logger.warn(
      { err },
      "retrieval lane: nightly eval skipped (clerk disabled or provider unavailable)",
    );
  }
});

// ---- Drop watch -------------------------------------------------------------

const MAX_BASELINE_RUNS = 5;
// Floored: a fractional env value must not smuggle in an off-by-one
// through the `< MIN + 1` comparison.
const MIN_BASELINE_RUNS = Math.min(
  Math.floor(envThreshold(process.env.RETRIEVAL_ALERT_MIN_RUNS, 3)),
  MAX_BASELINE_RUNS,
);
const DROP_POINTS = envThreshold(process.env.RETRIEVAL_ALERT_DROP, 0.15);

export const RETRIEVAL_DROP_ACTION = "clerk.retrieval_quality.dropped";

export interface RetrievalQualityDrop {
  metric: "recall" | "mrr";
  baselineRate: number;
  newestRate: number;
  baselineRuns: number;
  newestRunId: string;
}

export type RetrievalWatchRun = Pick<
  ClerkRetrievalEvalRun,
  "id" | "fixtureCount" | "hits" | "mrr"
>;

// Pure detection (the phrasing-watch shape): newest run vs the AGGREGATE of
// up to MAX_BASELINE_RUNS runs before it. Recall aggregates as summed hits
// over summed fixtures; MRR as the fixture-weighted mean. A model change is
// DELIBERATELY not excluded from the baseline — re-pointing
// CLERK_EMBEDDING_MODEL at a weaker model is precisely a drop an operator
// should hear about. Recall wins the report when both dropped — it is the
// metric retrieval surfaces actually gate on (k slots).
export function detectRetrievalQualityDrop(
  runs: RetrievalWatchRun[],
): RetrievalQualityDrop | null {
  if (runs.length < MIN_BASELINE_RUNS + 1) return null;
  const newest = runs[0];
  const baseline = runs.slice(1, 1 + MAX_BASELINE_RUNS);
  if (newest.fixtureCount === 0) return null;

  const drops: RetrievalQualityDrop[] = [];
  const baseFixtures = baseline.reduce((a, r) => a + r.fixtureCount, 0);
  if (baseFixtures > 0) {
    const baseRecall =
      baseline.reduce((a, r) => a + r.hits, 0) / baseFixtures;
    const newRecall = newest.hits / newest.fixtureCount;
    if (baseRecall - newRecall >= DROP_POINTS) {
      drops.push({
        metric: "recall",
        baselineRate: Number(baseRecall.toFixed(4)),
        newestRate: Number(newRecall.toFixed(4)),
        baselineRuns: baseline.length,
        newestRunId: newest.id,
      });
    }
    const baseMrr =
      baseline.reduce((a, r) => a + r.mrr * r.fixtureCount, 0) / baseFixtures;
    if (baseMrr - newest.mrr >= DROP_POINTS) {
      drops.push({
        metric: "mrr",
        baselineRate: Number(baseMrr.toFixed(4)),
        newestRate: Number(newest.mrr.toFixed(4)),
        baselineRuns: baseline.length,
        newestRunId: newest.id,
      });
    }
  }
  return drops.find((d) => d.metric === "recall") ?? drops[0] ?? null;
}

export interface RetrievalWatchDeps {
  runs: () => Promise<RetrievalWatchRun[]>;
}

const realDeps: RetrievalWatchDeps = {
  runs: () =>
    getDb()
      .select()
      .from(clerkRetrievalEvalRunsTable)
      .orderBy(
        desc(clerkRetrievalEvalRunsTable.createdAt),
        desc(clerkRetrievalEvalRunsTable.id),
      )
      .limit(1 + MAX_BASELINE_RUNS),
};

const alertRetrievalDrop = alertOnceViaAuditLedger({
  action: RETRIEVAL_DROP_ACTION,
  entityType: "clerk_retrieval_eval_run",
  actorId: "retrieval-watch",
});

export interface RetrievalWatchResult {
  checked: boolean;
  dropped: boolean;
  alerted: boolean;
}

export async function sweepRetrievalWatch(
  deps: RetrievalWatchDeps = realDeps,
): Promise<RetrievalWatchResult> {
  return runInBypassContext(async () => {
    const drop = detectRetrievalQualityDrop(await deps.runs());
    if (!drop) return { checked: true, dropped: false, alerted: false };
    const alerted = await alertRetrievalDrop(
      drop.newestRunId,
      {
        metric: drop.metric,
        baselineRate: drop.baselineRate,
        newestRate: drop.newestRate,
        baselineRuns: drop.baselineRuns,
        reason:
          "The newest retrieval eval run fell materially below the trailing baseline; check whether CLERK_EMBEDDING_MODEL changed and review the run's per-fixture ranks.",
      },
      `Memory retrieval ${drop.metric === "recall" ? `recall@${RETRIEVAL_K}` : "MRR"} DROPPED vs the trailing baseline: the embedding model may have changed or regressed — review before trusting memory surfaces.`,
    );
    return { checked: true, dropped: true, alerted };
  });
}

registerSweep(atMostHourly(sweepRetrievalWatch));
