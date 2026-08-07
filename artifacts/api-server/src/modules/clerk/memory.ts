import { sql } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  clerkMemoryEmbeddingsTable,
  EMBEDDING_DIMS,
} from "@workspace/db";
import { logger } from "../../lib/logger";
import { lagosMonthStart } from "./client-statement";
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
//    what happens with them is deterministic caller code. Where retrieved
//    text DOES ride a prompt (Phase 2's escalation-reply exemplar), the
//    caller re-reads it from the source row under its own firm filter and
//    inherits the surface's existing fence + deterministic copy backstop —
//    the index itself never hands text to anyone.
//  - Dark by default: the clerk_memory flag ships off (layered on
//    clerk_ai), and the rail also feature-detects the pgvector extension —
//    a cluster without it simply never indexes.

export const MEMORY_FLAG_KEY = "clerk_memory";
export const EMBED_PROMPT_VERSION = "embed.v1";
// Query-time embeds (a retrieval surface embedding ONE incoming text to
// search with, e.g. the reply-draft's escalation reason) carry their own
// version suffix so the ledger separates index spend from query spend —
// the "+ex1" cohort convention applied to the embedding lane.
export const EMBED_QUERY_PROMPT_VERSION = "embed.v1+q";
// Sources per indexer pass — the eval-growth batch discipline: slices, not
// marathons; the sweep's hourly cadence drains a backlog across passes.
export const MEMORY_INDEX_BATCH = 20;
// The exemplar cap, reused: embedding input is capped the same way prompt
// injection of the same text would be.
export const MEMORY_TEXT_CAP = 6_000;
// Fresh advisory lock id (731_842..846 clerk watches, 731_847 filing mint,
// 731_848 onboarding refresh).
const MEMORY_LOCK_ID = 731_850;

// The CLOSED corpus catalogue. Growing this list is a design decision, not
// a data change: every corpus needs a candidate query, a text builder, a
// sensitivity call and a purge story.
//  - ask_questions (Phase 1): resolved Ask questions — kind='question'
//    cases whose stored answer actually ANSWERED (a refusal stores an
//    answer blob too; it is no precedent). The question text is
//    firm-authored, never retention-purged (unlike extraction source_text,
//    so the index can never outlive its source), and it is the corpus
//    Phase 3's retrieval-augmented Ask reads.
//  - escalation_replies (Phase 2): REPLIED escalations, keyed by the
//    client-authored `reason` text — the retrieval question at draft time
//    is "which past escalation LOOKED like this one", so the situation is
//    the key and the operator's reply is what the caller re-reads from the
//    source row. Sensitivity: the reason is untrusted client text, but it
//    is only EMBEDDED here (vectors neither execute nor reproduce
//    instructions); the fence + copy-backstop duties live where the
//    SOURCE text rides a prompt (draft-reply.ts, unchanged). Purge story:
//    escalations are compliance records with no delete path (offboard
//    retains them), the reason is immutable after creation, and a re-sent
//    reply is picked up live because retrieval re-reads the source row.
//  - advisory_briefs (round 51): CLOSED-MONTH advisory briefs, keyed by
//    headline + adviser's note. The closed-month filter IS the
//    immutability guarantee: regeneration only ever touches the LIVE
//    month (generateAdvisoryBrief computes monthStart itself), so a past
//    month's text is frozen forever and the existence anti-join stays
//    honest — indexing the live month would serve stale vectors after
//    every refresh. Sensitivity: firm work product (template or phrased
//    note — platform-composed, never client-authored). Purge story:
//    briefs have no delete path; retrieval re-reads the source row under
//    scope, so an orphan embedding yields nothing.
export const MEMORY_CORPORA = [
  "ask_questions",
  "escalation_replies",
  "advisory_briefs",
] as const;
export type MemoryCorpusKey = (typeof MEMORY_CORPORA)[number];

interface IndexCandidate {
  firmId: string;
  corpus: MemoryCorpusKey;
  refId: string;
  text: string;
}

// The optional firm pin exists for TESTS (a suite indexes only its own
// salted firms instead of draining — and spending against — the whole
// scratch DB's candidate pool); production passes never set it. The alias
// must match the candidate query's source-table alias — typed as the
// closed set of aliases in use so nothing dynamic can ever reach sql.raw.
function firmPinClause(alias: "c" | "e" | "b", onlyFirmIds?: string[]) {
  return onlyFirmIds && onlyFirmIds.length > 0
    ? sql`AND ${sql.raw(alias)}.firm_id IN (${sql.join(
        onlyFirmIds.map((id) => sql`${id}`),
        sql`, `,
      )})`
    : sql``;
}

// The "not yet indexed" anti-join (the eval-growth discipline), model-aware:
// a row indexed under a PREVIOUS embedding model no longer matches the join
// and becomes a candidate again, so a model change re-indexes incrementally
// instead of serving mixed-model neighbours. Newest first — recent memory
// is the useful memory when a backlog drains slowly.
async function askQuestionCandidates(
  model: string,
  limit: number,
  onlyFirmIds?: string[],
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
        -- ANSWERED, not merely carrying an answer blob: a refusal stores
        -- {answered: false, refusalReason} too (ask.ts refuse()), and a
        -- refused question is no precedent — it must not consume k slots
        -- or be cited as "last time". Readers still re-check this on the
        -- source row (ask-memory.ts): rows indexed before this filter
        -- existed stay in the index until re-modeled.
        AND c.answer->>'answered' = 'true'
        AND m.id IS NULL
        ${firmPinClause("c", onlyFirmIds)}
      ORDER BY c.created_at DESC
      LIMIT ${limit}
    `)
  ).rows;
  return rows.map((r) => ({
    firmId: r.firm_id,
    corpus: "ask_questions" as const,
    refId: r.id,
    text: r.question.slice(0, MEMORY_TEXT_CAP),
  }));
}

// escalation_replies candidates: replied escalations, newest reply first
// (both operator_reply and replied_at are written together by the one
// reply writer, sendEscalationReply). The embedded text is the immutable
// client-authored reason — see the corpus catalogue above for why.
async function escalationReplyCandidates(
  model: string,
  limit: number,
  onlyFirmIds?: string[],
): Promise<IndexCandidate[]> {
  const rows = (
    await getDb().execute<{
      firm_id: string;
      id: string;
      reason: string;
    }>(sql`
      SELECT e.firm_id, e.id, e.reason
      FROM escalations e
      LEFT JOIN clerk_memory_embeddings m
        ON m.firm_id = e.firm_id
       AND m.corpus = 'escalation_replies'
       AND m.ref_id = e.id
       AND m.model = ${model}
      WHERE e.operator_reply IS NOT NULL
        AND m.id IS NULL
        ${firmPinClause("e", onlyFirmIds)}
      ORDER BY e.replied_at DESC NULLS LAST
      LIMIT ${limit}
    `)
  ).rows;
  return rows.map((r) => ({
    firmId: r.firm_id,
    corpus: "escalation_replies" as const,
    refId: r.id,
    text: r.reason.slice(0, MEMORY_TEXT_CAP),
  }));
}

// advisory_briefs candidates: CLOSED-month briefs only — regeneration is
// live-month-only by construction, so a past month's headline + note are
// frozen and the existence anti-join stays honest (see the catalogue).
async function advisoryBriefCandidates(
  model: string,
  limit: number,
  onlyFirmIds?: string[],
): Promise<IndexCandidate[]> {
  const liveMonth = lagosMonthStart(0);
  const rows = (
    await getDb().execute<{
      firm_id: string;
      id: string;
      headline: string;
      note: string;
    }>(sql`
      SELECT b.firm_id, b.id, b.headline, b.note
      FROM clerk_advisory_briefs b
      LEFT JOIN clerk_memory_embeddings m
        ON m.firm_id = b.firm_id
       AND m.corpus = 'advisory_briefs'
       AND m.ref_id = b.id
       AND m.model = ${model}
      WHERE b.month_start < ${liveMonth}
        AND m.id IS NULL
        ${firmPinClause("b", onlyFirmIds)}
      ORDER BY b.month_start DESC
      LIMIT ${limit}
    `)
  ).rows;
  return rows.map((r) => ({
    firmId: r.firm_id,
    corpus: "advisory_briefs" as const,
    refId: r.id,
    text: `${r.headline}\n${r.note}`.slice(0, MEMORY_TEXT_CAP),
  }));
}

// One candidate source per catalogue entry, keyed by MEMORY_CORPORA's
// union type — adding a corpus to the catalogue without wiring its
// candidate query is a COMPILE error, never a silent no-op.
const CORPUS_CANDIDATES: Record<
  MemoryCorpusKey,
  (
    model: string,
    limit: number,
    onlyFirmIds?: string[],
  ) => Promise<IndexCandidate[]>
> = {
  ask_questions: askQuestionCandidates,
  escalation_replies: escalationReplyCandidates,
  advisory_briefs: advisoryBriefCandidates,
};

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
  opts: { onlyFirmIds?: string[] } = {},
): Promise<{ indexed: number; skippedFirms: number }> {
  // Each corpus contributes up to `limit` candidates per pass (a fat
  // backlog in one corpus must not starve the other); one firm's mixed-
  // corpus texts still share ONE embedding call below.
  const candidates = await runInBypassContext(async () => {
    const all: IndexCandidate[] = [];
    for (const corpus of MEMORY_CORPORA) {
      all.push(
        ...(await CORPUS_CANDIDATES[corpus](
          embedder.model,
          limit,
          opts.onlyFirmIds,
        )),
      );
    }
    return all;
  });
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
    // PER-FIRM flag wall: the operator override surface can turn clerk_ai
    // or clerk_memory off for ONE firm (an incident, a consent withdrawal)
    // — a firm dark on either flag must not have its questions embedded or
    // its budget charged by a background sweep the request paths would
    // refuse (the agreement-watch precedent for firm-spending sweeps).
    if (
      !(await isFeatureEnabled(CLERK_FLAG_KEY, firmId)) ||
      !(await isFeatureEnabled(MEMORY_FLAG_KEY, firmId))
    ) {
      skippedFirms += 1;
      continue;
    }
    // One broken firm (a storage error, a poisoned vector) must not abort
    // the rest of the pass — and must not starve the firms sorted after it
    // on every retry.
    try {
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
              corpus: c.corpus,
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
    } catch (err) {
      skippedFirms += 1;
      logger.warn(
        { firmId, err: err instanceof Error ? err.message : String(err) },
        "memory indexer: firm batch failed",
      );
    }
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
  // mention — an empty result is the honest answer, never padding. Applied
  // in the WHERE clause, BEFORE the k cut, so sub-floor rows never crowd a
  // viable match out of the k slots.
  minSimilarity?: number;
  // Exclude one source row in SQL — a caller searching with a text that is
  // itself indexed (a re-draft of a replied escalation) would otherwise
  // find itself at similarity 1. uuid-typed comparison, so caller-supplied
  // casing cannot defeat it, and the excluded row never wastes a k slot.
  excludeRefId?: string;
}): Promise<MemoryMatch[]> {
  const vectorLiteral = `[${params.vector.join(",")}]`;
  const floor = params.minSimilarity ?? 0;
  const exclusion = params.excludeRefId
    ? sql`AND ref_id <> ${params.excludeRefId}::uuid`
    : sql``;
  const rows = (
    await getDb().execute<{ ref_id: string; similarity: number }>(sql`
      SELECT ref_id,
             1 - (embedding <=> ${vectorLiteral}::vector) AS similarity
      FROM clerk_memory_embeddings
      WHERE firm_id = ${params.firmId}
        AND corpus = ${params.corpus}
        AND model = ${params.model}
        AND 1 - (embedding <=> ${vectorLiteral}::vector) >= ${floor}
        ${exclusion}
      ORDER BY embedding <=> ${vectorLiteral}::vector
      LIMIT ${params.k}
    `)
  ).rows;
  return rows.map((r) => ({
    refId: r.ref_id,
    similarity: Number(r.similarity),
  }));
}

// Existence probe for one (firm, corpus, model) slice — retrieval surfaces
// call this BEFORE spending the firm's tokens on a query embed: an empty
// slice cannot match anything, so the honest and free answer is "no".
export async function memoryCorpusPopulated(
  firmId: string,
  corpus: MemoryCorpusKey,
  model: string,
): Promise<boolean> {
  const rows = (
    await getDb().execute(sql`
      SELECT 1 FROM clerk_memory_embeddings
      WHERE firm_id = ${firmId}
        AND corpus = ${corpus}
        AND model = ${model}
      LIMIT 1
    `)
  ).rows;
  return rows.length > 0;
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
