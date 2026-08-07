import { sql } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  clerkMemoryEmbeddingsTable,
  EMBEDDING_DIMS,
} from "@workspace/db";
import { logger } from "../../lib/logger";
import { isFeatureEnabled } from "../flags/flags";
import { registerSweep } from "../pipeline/pipeline";
import { atMostHourly } from "./watch-shared";
import {
  CLERK_FLAG_KEY,
  embedWithLedger,
  sha256,
  type MemoryEmbedder,
} from "./gateway";
import { embedderOrNull } from "./provider";

// pgvector firm memory (round 45, Phase 1): the semantic index over a
// firm's OWN Clerk records — so Clerk's memories stop being exact-key
// lookups and start finding "the last time something like this happened".
// The rail, stated once:
//  - EVERY embedding call flows through the gateway's embedWithLedger lane
//    (kill switch, per-firm budget before spend, append-only ledger on the
//    raw pool, fail closed) — embedding spend is never free and never
//    unrecorded.
//  - The index is POINTER-ONLY: a row is (firm, corpus, source row id,
//    content hash, model, vector). The embedded text is never stored here;
//    the source row is the only way back to content, so purging the source
//    purges the meaning.
//  - CROSS-FIRM NEVER: every read and write carries the firm id, and the
//    firm-keyed RLS policy (migration 0039) backstops the query filter.
//    Firm-keyed RLS is NOT a sibling wall — any client-facing retrieval
//    surface must additionally pin the caller's own party (Phase 2's duty).
//  - THE APP PICKS, NEVER THE MODEL: retrieval returns ranked source ids;
//    what happens with them is deterministic caller code. No retrieved text
//    reaches a prompt in Phase 1 at all.
//  - Dark by default: the clerk_memory flag ships off (layered on
//    clerk_ai), and the rail also feature-detects the pgvector extension —
//    a cluster without it simply never indexes.

export const MEMORY_FLAG_KEY = "clerk_memory";
export const EMBED_PROMPT_VERSION = "embed.v1";
// Sources per indexer pass — the eval-growth batch discipline: slices, not
// marathons; the sweep's hourly cadence drains a backlog across passes.
export const MEMORY_INDEX_BATCH = 20;
// The exemplar cap, reused: embedding input is capped the same way prompt
// injection of the same text would be.
export const MEMORY_TEXT_CAP = 6_000;
// Fresh advisory lock id (731_842..849 taken: clerk watches, filing mint,
// onboarding refresh).
const MEMORY_LOCK_ID = 731_850;

// The CLOSED corpus catalogue. Phase 1 indexes one corpus — resolved Ask
// questions (kind='question' cases with an answer): the question text is
// firm-authored, never retention-purged (unlike extraction source_text, so
// the index can never outlive its source), and it is the corpus Phase 3's
// retrieval-augmented Ask reads. Growing this list is a design decision,
// not a data change: every corpus needs a candidate query, a text builder,
// a sensitivity call and a purge story.
export const MEMORY_CORPORA = ["ask_questions"] as const;
export type MemoryCorpusKey = (typeof MEMORY_CORPORA)[number];

interface IndexCandidate {
  firmId: string;
  refId: string;
  text: string;
}

// The "not yet indexed" anti-join (the eval-growth discipline), model-aware:
// a row indexed under a PREVIOUS embedding model no longer matches the join
// and becomes a candidate again, so a model change re-indexes incrementally
// instead of serving mixed-model neighbours. Newest first — recent memory
// is the useful memory when a backlog drains slowly.
async function askQuestionCandidates(
  model: string,
  limit: number,
): Promise<IndexCandidate[]> {
  const rows = (
    await getDb().execute<{
      firm_id: string;
      id: string;
      question: string;
    }>(sql`
      SELECT c.firm_id, c.id, c.question
      FROM clerk_cases c
      LEFT JOIN clerk_memory_embeddings m
        ON m.firm_id = c.firm_id
       AND m.corpus = 'ask_questions'
       AND m.ref_id = c.id
       AND m.model = ${model}
      WHERE c.kind = 'question'
        AND c.firm_id IS NOT NULL
        AND c.question IS NOT NULL
        AND c.answer IS NOT NULL
        AND m.id IS NULL
      ORDER BY c.created_at DESC
      LIMIT ${limit}
    `)
  ).rows;
  return rows.map((r) => ({
    firmId: r.firm_id,
    refId: r.id,
    text: r.question.slice(0, MEMORY_TEXT_CAP),
  }));
}

// Index one batch: candidates in a short bypass read, then ONE embedding
// call per firm (the budget is per-firm, so the batch groups by firm), then
// upserts under bypass. Idempotent and multi-instance safe: the natural
// unique key absorbs races (two instances embedding the same row cost one
// duplicate call at worst, never a duplicate row), and a firm whose budget
// is exhausted is SKIPPED this pass — a typed failure with no ledger row —
// while other firms still index.
export async function indexMemoryBatch(
  embedder: MemoryEmbedder,
  limit = MEMORY_INDEX_BATCH,
): Promise<{ indexed: number; skippedFirms: number }> {
  const candidates = await runInBypassContext(() =>
    askQuestionCandidates(embedder.model, limit),
  );
  if (candidates.length === 0) return { indexed: 0, skippedFirms: 0 };

  const byFirm = new Map<string, IndexCandidate[]>();
  for (const c of candidates) {
    const list = byFirm.get(c.firmId) ?? [];
    list.push(c);
    byFirm.set(c.firmId, list);
  }

  let indexed = 0;
  let skippedFirms = 0;
  for (const [firmId, firmCandidates] of byFirm) {
    const result = await embedWithLedger(embedder, {
      firmId,
      texts: firmCandidates.map((c) => c.text),
      promptVersion: EMBED_PROMPT_VERSION,
      dims: EMBEDDING_DIMS,
    });
    if (!result.ok) {
      // Budget exhausted / provider failure: nothing stored for this firm
      // this pass; the anti-join re-offers the same rows next pass.
      skippedFirms += 1;
      continue;
    }
    await runInBypassContext(async () => {
      for (let i = 0; i < firmCandidates.length; i++) {
        const c = firmCandidates[i];
        await getDb()
          .insert(clerkMemoryEmbeddingsTable)
          .values({
            firmId: c.firmId,
            corpus: "ask_questions",
            refId: c.refId,
            contentHash: sha256(c.text),
            model: result.model,
            embedding: result.vectors[i],
          })
          .onConflictDoUpdate({
            target: [
              clerkMemoryEmbeddingsTable.firmId,
              clerkMemoryEmbeddingsTable.corpus,
              clerkMemoryEmbeddingsTable.refId,
            ],
            set: {
              contentHash: sha256(c.text),
              model: result.model,
              embedding: result.vectors[i],
              updatedAt: new Date(),
            },
          });
      }
    });
    indexed += firmCandidates.length;
  }
  return { indexed, skippedFirms };
}

export interface MemoryMatch {
  refId: string;
  similarity: number;
}

// Exact cosine KNN over ONE firm's ONE corpus, model-pinned (vectors from
// different embedding models are not comparable). Exact by design — see the
// schema's no-ANN-index note. The explicit firm filter is belt-and-braces
// with the RLS policy; callers run inside their own firm scope (or the
// sweep's bypass), and what they DO with the ranked ids is deterministic
// caller code — the app picks, never the model.
export async function searchMemory(params: {
  firmId: string;
  corpus: MemoryCorpusKey;
  model: string;
  vector: number[];
  k: number;
  // Similarity floor: below it, the past simply was not similar enough to
  // mention — an empty result is the honest answer, never padding.
  minSimilarity?: number;
}): Promise<MemoryMatch[]> {
  const vectorLiteral = `[${params.vector.join(",")}]`;
  const rows = (
    await getDb().execute<{ ref_id: string; similarity: number }>(sql`
      SELECT ref_id,
             1 - (embedding <=> ${vectorLiteral}::vector) AS similarity
      FROM clerk_memory_embeddings
      WHERE firm_id = ${params.firmId}
        AND corpus = ${params.corpus}
        AND model = ${params.model}
      ORDER BY embedding <=> ${vectorLiteral}::vector
      LIMIT ${params.k}
    `)
  ).rows;
  const floor = params.minSimilarity ?? 0;
  return rows
    .map((r) => ({ refId: r.ref_id, similarity: Number(r.similarity) }))
    .filter((m) => m.similarity >= floor);
}

// The rail's runtime availability: both flags lit AND the extension
// actually installed (a cluster without the pgvector binary never indexes —
// the 0038 migration downgraded its failure to a warning for exactly this
// check to pick up).
export async function memoryRailReady(): Promise<boolean> {
  if (!(await isFeatureEnabled(CLERK_FLAG_KEY))) return false;
  if (!(await isFeatureEnabled(MEMORY_FLAG_KEY))) return false;
  const ext = (
    await getDb().execute(
      sql`SELECT 1 FROM pg_extension WHERE extname = 'vector' LIMIT 1`,
    )
  ).rows;
  return ext.length > 0;
}

// Hourly indexer sweep (the eval-growth shape): gating — try-lock + both
// flags + the extension — in a SHORT bypass transaction; the embedding
// calls run OUTSIDE it (holding a pooled connection across a slow provider
// would stall every time-sensitive sweep behind this one). The xact lock
// only dedupes one instance's pass; correctness rests on the natural key
// and the per-firm budget, so a cross-instance race costs at most one
// duplicate batch spend.
export async function sweepMemoryIndex(): Promise<void> {
  const due = await runInBypassContext(async () => {
    const [{ locked }] = (
      await getDb().execute<{ locked: boolean }>(
        sql`SELECT pg_try_advisory_xact_lock(${MEMORY_LOCK_ID}) AS locked`,
      )
    ).rows;
    if (!locked) return false;
    return memoryRailReady();
  });
  if (!due) return;
  const embedder = await embedderOrNull();
  if (!embedder) return;
  try {
    const { indexed, skippedFirms } = await indexMemoryBatch(embedder);
    if (indexed > 0 || skippedFirms > 0) {
      logger.info({ indexed, skippedFirms }, "memory indexer pass");
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "memory indexer sweep failed",
    );
  }
}

registerSweep(atMostHourly(() => sweepMemoryIndex()));
