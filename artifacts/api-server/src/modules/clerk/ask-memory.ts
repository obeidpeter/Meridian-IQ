import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  getDb,
  clerkAdvisoryBriefsTable,
  clerkCasesTable,
  EMBEDDING_DIMS,
} from "@workspace/db";
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
  // The source row's id: an Ask case, or (round 51) an advisory brief —
  // `kind` says which surface the caller should open it in.
  caseId: string;
  question: string;
  askedAt: string;
  kind: "question" | "advisory_brief";
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
  // The client asker's own party (round 51): advisory-brief items are
  // client-scoped ROWS, so a client asker's brief re-read pins
  // clientPartyId — the sibling wall for briefs, as createdBy is for
  // question cases. A clientScoped caller without a party gets NO brief
  // items (fail closed); firm callers see the firm's briefs.
  clientPartyId?: string | null;
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
    // Cold-corpus guard (the R46 rule), per corpus: an empty (firm,
    // corpus, model) slice cannot match anything — the embed is charged
    // only when at least one corpus can answer, and only populated
    // corpora are searched.
    const [questionsPopulated, briefsPopulated] = await inClerkScope(
      params.firmId,
      async () =>
        [
          await memoryCorpusPopulated(
            params.firmId,
            "ask_questions",
            embedder.model,
          ),
          await memoryCorpusPopulated(
            params.firmId,
            "advisory_briefs",
            embedder.model,
          ),
        ] as const,
    );
    // A clientScoped caller with no party can never receive a brief item
    // (the SEC-03 wall at the re-read fails closed) — so for them the
    // briefs corpus counts as unsearchable HERE, before the embed: they
    // must not be charged for a guaranteed-zero search.
    const briefsSearchable =
      briefsPopulated && !(params.clientScoped && !params.clientPartyId);
    if (!questionsPopulated && !briefsSearchable) return undefined;

    const embedded = await embedWithLedger(embedder, {
      firmId: params.firmId,
      texts: [params.question.slice(0, MEMORY_TEXT_CAP)],
      promptVersion: EMBED_QUERY_PROMPT_VERSION,
      dims: EMBEDDING_DIMS,
    });
    if (!embedded.ok) return undefined;

    // A client asker searches WIDER: the index has no creator/party
    // dimension, so the own-rows pins below discard out-of-scope matches
    // post-search — with only k slots, the asker's own similar row at
    // rank 4 would never surface. Exact per-firm scan; wider k is free.
    const k = params.clientScoped ? ASK_MEMORY_K * 3 : ASK_MEMORY_K;
    const matches = await inClerkScope(params.firmId, async () => {
      const searchCorpus = (corpus: "ask_questions" | "advisory_briefs") =>
        searchMemory({
          firmId: params.firmId,
          corpus,
          model: embedded.model,
          vector: embedded.vectors[0],
          k,
          minSimilarity: ASK_MEMORY_MIN_SIMILARITY,
          excludeRefId: params.excludeCaseId,
        });
      const questionMatches = questionsPopulated
        ? await searchCorpus("ask_questions")
        : [];
      const briefMatches = briefsSearchable
        ? await searchCorpus("advisory_briefs")
        : [];
      // One ranked list across both corpora — the similarity floor already
      // applied per search; the cap below picks the best of either kind.
      return [
        ...questionMatches.map((m) => ({
          ...m,
          corpus: "ask_questions" as const,
        })),
        ...briefMatches.map((m) => ({
          ...m,
          corpus: "advisory_briefs" as const,
        })),
      ].sort((a, b) => b.similarity - a.similarity);
    });
    if (matches.length === 0) return undefined;

    // Pointer-only re-reads, ONE scope per corpus batch, then picked in
    // rank order and capped: the index stores no text, so every item's
    // display text comes LIVE from its source row under the firm pin plus
    // the SEC-03 sibling wall for a client asker — createdBy for question
    // cases, clientPartyId for briefs (a clientScoped caller without a
    // party gets no brief items at all, fail closed). The answered check
    // is LOAD-BEARING for question rows indexed before that filter
    // existed: a refusal is no precedent.
    const questionIds = matches
      .filter((m) => m.corpus === "ask_questions")
      .map((m) => m.refId);
    // Brief matches only exist when briefsSearchable held above, so the
    // party-less clientScoped case is already an empty list here.
    const briefIds = matches
      .filter((m) => m.corpus === "advisory_briefs")
      .map((m) => m.refId);
    const caseRows =
      questionIds.length > 0
        ? await inClerkScope(params.firmId, () =>
            getDb()
              .select({
                id: clerkCasesTable.id,
                question: clerkCasesTable.question,
                createdAt: clerkCasesTable.createdAt,
              })
              .from(clerkCasesTable)
              .where(
                and(
                  inArray(clerkCasesTable.id, questionIds),
                  eq(clerkCasesTable.firmId, params.firmId),
                  eq(clerkCasesTable.kind, "question"),
                  isNotNull(clerkCasesTable.answer),
                  sql`${clerkCasesTable.answer}->>'answered' = 'true'`,
                  ...(params.clientScoped
                    ? [eq(clerkCasesTable.createdBy, params.actorId)]
                    : []),
                ),
              ),
          )
        : [];
    const briefRows =
      briefIds.length > 0
        ? await inClerkScope(params.firmId, () =>
            getDb()
              .select({
                id: clerkAdvisoryBriefsTable.id,
                headline: clerkAdvisoryBriefsTable.headline,
                // createdAt, deliberately: updatedAt is bumped by refresh
                // and would date last month's brief as "today".
                createdAt: clerkAdvisoryBriefsTable.createdAt,
              })
              .from(clerkAdvisoryBriefsTable)
              .where(
                and(
                  inArray(clerkAdvisoryBriefsTable.id, briefIds),
                  eq(clerkAdvisoryBriefsTable.firmId, params.firmId),
                  ...(params.clientScoped
                    ? [
                        eq(
                          clerkAdvisoryBriefsTable.clientPartyId,
                          params.clientPartyId!,
                        ),
                      ]
                    : []),
                ),
              ),
          )
        : [];
    const caseById = new Map(caseRows.map((r) => [r.id, r]));
    const briefById = new Map(briefRows.map((r) => [r.id, r]));
    const items: AskAnswerMemoryItem[] = [];
    for (const match of matches) {
      if (items.length >= ASK_MEMORY_MAX_ITEMS) break;
      if (match.corpus === "ask_questions") {
        const row = caseById.get(match.refId);
        if (row?.question) {
          items.push({
            caseId: row.id,
            question: row.question,
            askedAt: row.createdAt.toISOString(),
            kind: "question",
          });
        }
      } else {
        const row = briefById.get(match.refId);
        if (row?.headline) {
          items.push({
            caseId: row.id,
            question: row.headline,
            askedAt: row.createdAt.toISOString(),
            kind: "advisory_brief",
          });
        }
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
