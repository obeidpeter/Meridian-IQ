import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { getDb, clerkCasesTable, EMBEDDING_DIMS } from "@workspace/db";
import { logger } from "../../lib/logger";
import { isFeatureEnabled } from "../flags/flags";
import {
  CLERK_FLAG_KEY,
  embedWithLedger,
  type MemoryEmbedder,
} from "./gateway";
import {
  EMBED_QUERY_PROMPT_VERSION,
  MEMORY_FLAG_KEY,
  MEMORY_TEXT_CAP,
  memoryCorpusPopulated,
  memoryRailReady,
  searchMemory,
} from "./memory";
import { embedderOrNull } from "./provider";
import { inClerkScope } from "./scope";

// Retrieval-augmented Ask (round 47, Phase 3): after an Ask answer is
// COMPLETE, app code — never the model — looks up the firm's own answered
// questions that resembled this one and attaches them as a pointer-first
// "last time something like this happened" note on the stored answer.
// The posture, stated once:
//  - NO MODEL INVOLVEMENT: the answer itself is already finished when this
//    runs; retrieval output goes straight into the stored answer's `memory`
//    field as app-assembled display data. Nothing here rides a prompt, so
//    the intent eval's frozen contract (buildIntentUser) is untouched.
//  - POINTER-FIRST: each item is (caseId, question, askedAt). The past
//    ANSWER is deliberately not repeated — it is one click away in the
//    asker's own Ask history, which re-enforces scope on read.
//  - SEC-03: the stored answer IS the API answer (ask.ts), so scope is
//    enforced at ASSEMBLY time — a client asker's items are drawn only
//    from cases that asker created (the multi-turn previousCaseId pin,
//    createdBy = actorId), because firm-keyed RLS is not a sibling wall
//    and a sibling client's question text must never be stored into this
//    asker's answer.
//  - BEST-EFFORT AND FIRM-FUNDED: the query embed spends the firm's
//    tokens through embedWithLedger (cohort embed.v1+q — the memory is the
//    firm's asset), and every gate or failure — rail dark, firm overridden
//    off, cold corpus, budget exhausted, provider down — simply yields no
//    memory note, never a failed answer.

export interface AskAnswerMemoryItem {
  caseId: string;
  question: string;
  askedAt: string;
}

// Mirrors components/schemas AskAnswerMemory in lib/api-spec/openapi.yaml
// (the ask.ts AskAnswer rule: the stored answer is the API answer).
export interface AskAnswerMemory {
  title: string;
  items: AskAnswerMemoryItem[];
}

export const ASK_MEMORY_K = 3;
// A question has to be genuinely similar to be worth mentioning — the Ask
// floor sits above the reply-draft's (0.3): a wrong "you asked this
// before" is noise on every answer, not just a discarded draft.
export const ASK_MEMORY_MIN_SIMILARITY = 0.35;
export const ASK_MEMORY_MAX_ITEMS = 2;
export const ASK_MEMORY_TITLE = "Last time something like this happened";
// The note is garnish on the USER-FACING Ask response path: a degraded
// embedding endpoint must delay the answer by at most this much, not by
// the provider SDK's minutes-long default timeout. The raced-out compute
// keeps running to completion in the background — its ledger row still
// lands, nothing is half-written (the note performs no writes) — we
// simply stop waiting for it.
export const ASK_MEMORY_DEADLINE_MS = 2_000;

// ask.ts runs OUTSIDE the per-request transaction (NO_CONTEXT route), so
// every tenant-data read here opens its own short firm scope (inClerkScope)
// — the memory table's firm-keyed RLS applies exactly as a request would
// have it. embedWithLedger is called bare, precisely like ask.ts's own
// gateway.infer (flags and ledger surfaces carry their own posture).
export async function computeAskMemory(
  params: AskMemoryParams,
): Promise<AskAnswerMemory | undefined> {
  return Promise.race([
    computeAskMemoryInner(params),
    new Promise<undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), ASK_MEMORY_DEADLINE_MS);
      timer.unref();
    }),
  ]);
}

interface AskMemoryParams {
  firmId: string;
  question: string;
  actorId: string;
  clientScoped: boolean;
  // The case being answered RIGHT NOW: excluded from retrieval in SQL. It
  // is unanswered at this point so the indexer cannot have offered it, but
  // the exclusion is free and survives any future reordering.
  excludeCaseId: string;
  // Tests inject a deterministic embedder; production omits it and the
  // provider embedder resolves lazily, only after the gates pass. An
  // explicit null means "no embedder" — the note is skipped.
  embedder?: MemoryEmbedder | null;
}

async function computeAskMemoryInner(
  params: AskMemoryParams,
): Promise<AskAnswerMemory | undefined> {
  try {
    if (!(await memoryRailReady())) return undefined;
    if (!(await isFeatureEnabled(CLERK_FLAG_KEY, params.firmId))) {
      return undefined;
    }
    if (!(await isFeatureEnabled(MEMORY_FLAG_KEY, params.firmId))) {
      return undefined;
    }
    const embedder =
      params.embedder === undefined ? await embedderOrNull() : params.embedder;
    if (!embedder) return undefined;
    // Cold-corpus guard (the R46 rule): an empty (firm, corpus, model)
    // slice cannot match anything — never charge the firm for a
    // guaranteed-no-match query embed.
    const populated = await inClerkScope(params.firmId, () =>
      memoryCorpusPopulated(params.firmId, "ask_questions", embedder.model),
    );
    if (!populated) return undefined;

    const embedded = await embedWithLedger(embedder, {
      firmId: params.firmId,
      texts: [params.question.slice(0, MEMORY_TEXT_CAP)],
      promptVersion: EMBED_QUERY_PROMPT_VERSION,
      dims: EMBEDDING_DIMS,
    });
    if (!embedded.ok) return undefined;

    const matches = await inClerkScope(params.firmId, () =>
      searchMemory({
        firmId: params.firmId,
        corpus: "ask_questions",
        model: embedded.model,
        vector: embedded.vectors[0],
        // A client asker searches WIDER: the index has no creator
        // dimension, so the own-cases pin below discards firm-staff
        // matches post-search — with only k slots, the asker's own
        // similar case at rank 4 would never surface. Exact per-firm
        // scan; the wider k costs nothing.
        k: params.clientScoped ? ASK_MEMORY_K * 3 : ASK_MEMORY_K,
        minSimilarity: ASK_MEMORY_MIN_SIMILARITY,
        excludeRefId: params.excludeCaseId,
      }),
    );
    if (matches.length === 0) return undefined;

    // Pointer-only re-read, ONE scope for the whole batch, then picked in
    // rank order and capped: the index stores no text, so each item's
    // question comes LIVE from the case row under the firm pin (+ the
    // SEC-03 own-cases pin for a client asker) — an orphaned or
    // out-of-scope embedding row yields nothing rather than leaking. The
    // answered check is LOAD-BEARING here, not just in the candidate
    // query: rows indexed before that filter existed (or under an older
    // model) can still name a refused case, and a refusal is no precedent.
    const rows = await inClerkScope(params.firmId, () =>
      getDb()
        .select({
          id: clerkCasesTable.id,
          question: clerkCasesTable.question,
          createdAt: clerkCasesTable.createdAt,
        })
        .from(clerkCasesTable)
        .where(
          and(
            inArray(
              clerkCasesTable.id,
              matches.map((m) => m.refId),
            ),
            eq(clerkCasesTable.firmId, params.firmId),
            eq(clerkCasesTable.kind, "question"),
            isNotNull(clerkCasesTable.answer),
            sql`${clerkCasesTable.answer}->>'answered' = 'true'`,
            ...(params.clientScoped
              ? [eq(clerkCasesTable.createdBy, params.actorId)]
              : []),
          ),
        ),
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    const items: AskAnswerMemoryItem[] = [];
    for (const match of matches) {
      if (items.length >= ASK_MEMORY_MAX_ITEMS) break;
      const row = byId.get(match.refId);
      if (row?.question) {
        items.push({
          caseId: row.id,
          question: row.question,
          askedAt: row.createdAt.toISOString(),
        });
      }
    }
    if (items.length === 0) return undefined;
    return { title: ASK_MEMORY_TITLE, items };
  } catch (err) {
    // Best-effort: a retrieval failure means "no memory note", never a
    // failed answer — but a SYSTEMIC breakage (a bad column, a broken
    // scope) should not be invisible forever, so it leaves a debug trace.
    logger.debug(
      { err: err instanceof Error ? err.message : String(err) },
      "ask memory note skipped (retrieval failure)",
    );
    return undefined;
  }
}
