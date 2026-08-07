import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
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
import type { MemoryEmbedder } from "./gateway.ts";
import {
  ASK_MEMORY_MAX_ITEMS,
  ASK_MEMORY_TITLE,
  computeAskMemory,
} from "./ask-memory.ts";
import { indexMemoryBatch, MEMORY_FLAG_KEY } from "./memory.ts";
import {
  restoreClerkFlag,
  saveAndEnableClerkFlag,
} from "./test-support.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Retrieval-augmented Ask (round 47): the memory note. Pinned invariants:
//  - similarity-ranked, capped at ASK_MEMORY_MAX_ITEMS, pointer-first
//    (caseId + question + askedAt — never the past answer);
//  - SEC-03: a CLIENT asker's items come only from cases that asker
//    created (createdBy pin), even when a sibling's question is the top
//    similarity match;
//  - the rail dark (clerk_memory off) yields no note and no embed call;
//  - a cold (firm, corpus, model) slice yields no note and NO embed spend.

const SALT = makeRunSalt();

const firmId = randomUUID();
const firmUserId = randomUUID(); // firm staff — created vatCase/payeCase
const clientUserId = randomUUID(); // client user — created ownCase only
const vatCase = randomUUID();
const payeCase = randomUUID();
const ownCase = randomUUID();
const refusedCase = randomUUID(); // stored answer has answered: false

function axisVector(i: number, scale = 1): number[] {
  const v = new Array<number>(EMBEDDING_DIMS).fill(0);
  v[i] = scale;
  return v;
}
// Geometry: the query lands closest to the VAT case (0.9), then the client
// user's own case (0.6), then payroll (orthogonal, below the floor).
const QUERY_VECTOR = axisVector(0);
const VAT_VECTOR = (() => {
  const v = new Array<number>(EMBEDDING_DIMS).fill(0);
  v[0] = 0.9;
  v[1] = Math.sqrt(1 - 0.81);
  return v;
})();
const OWN_VECTOR = (() => {
  const v = new Array<number>(EMBEDDING_DIMS).fill(0);
  v[0] = 0.6;
  v[2] = 0.8;
  return v;
})();
const PAYE_VECTOR = axisVector(3);

function fakeEmbedder(): MemoryEmbedder & { calls: number } {
  const embedder = {
    model: `fake-ask-embed-${SALT}`,
    calls: 0,
    async embed(texts: string[]) {
      embedder.calls += 1;
      return {
        vectors: texts.map((t) =>
          t.includes("VAT position")
            ? VAT_VECTOR
            : t.includes("my own filings")
              ? OWN_VECTOR
              : t.includes("payroll")
                ? PAYE_VECTOR
                : QUERY_VECTOR,
        ),
        promptTokens: 21,
      };
    },
  };
  return embedder;
}

before(async () => {
  await saveAndEnableClerkFlag();
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
  await db.insert(firmsTable).values({ id: firmId, name: `AskMem ${SALT}` });
  await db
    .insert(usersTable)
    .values([
      { id: firmUserId, email: `askmem-firm-${SALT}@test.local` },
      { id: clientUserId, email: `askmem-client-${SALT}@test.local` },
    ])
    .onConflictDoNothing();
  const answer = { answered: true, proposition: `answered ${SALT}`, facts: [] };
  await db.insert(clerkCasesTable).values([
    {
      id: vatCase,
      firmId,
      kind: "question",
      status: "approved",
      createdBy: firmUserId,
      question: `What is our VAT position this month? ${SALT}`,
      answer,
    },
    {
      id: payeCase,
      firmId,
      kind: "question",
      status: "approved",
      createdBy: firmUserId,
      question: `When is payroll tax due? ${SALT}`,
      answer,
    },
    {
      id: ownCase,
      firmId,
      kind: "question",
      status: "approved",
      createdBy: clientUserId,
      question: `Are my own filings up to date? ${SALT}`,
      answer,
    },
    {
      // A REFUSAL also stores a non-null answer blob — it must neither be
      // indexed (the candidates filter) nor cited (the re-read filter).
      id: refusedCase,
      firmId,
      kind: "question",
      status: "escalated",
      createdBy: firmUserId,
      question: `Refused VAT ask ${SALT}`,
      answer: { answered: false, refusalReason: `refused ${SALT}` },
    },
  ]);
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

test("firm asker: similarity-ranked pointer items, capped, firm-funded query embed", async () => {
  const embedder = fakeEmbedder();
  const pass = await indexMemoryBatch(embedder, 20, { onlyFirmIds: [firmId] });
  // 3, not 4: the refused case's non-null answer blob does NOT make it a
  // candidate — only questions whose answer actually answered are indexed.
  assert.equal(pass.indexed, 3, "the three ANSWERED questions indexed");

  const memory = await computeAskMemory({
    firmId,
    question: `how do we stand on VAT right now? ${SALT}`,
    actorId: firmUserId,
    clientScoped: false,
    excludeCaseId: randomUUID(),
    embedder,
  });
  assert.ok(memory, "a similar past question yields a note");
  assert.equal(memory.title, ASK_MEMORY_TITLE);
  assert.ok(memory.items.length <= ASK_MEMORY_MAX_ITEMS);
  assert.equal(
    memory.items[0].caseId,
    vatCase,
    "closest question ranks first",
  );
  assert.ok(memory.items[0].question.includes("VAT position"));
  assert.ok(memory.items[0].askedAt.length > 0);
  // Below-floor questions (payroll, orthogonal) never pad the list.
  assert.ok(
    memory.items.every((i) => i.caseId !== payeCase),
    "sub-floor matches are not padding",
  );
  // The query embed was charged to the firm under the query cohort.
  const [ledger] = await runInBypassContext(() =>
    getDb()
      .select({ promptVersion: clerkInferenceCallsTable.promptVersion })
      .from(clerkInferenceCallsTable)
      .where(
        and(
          eq(clerkInferenceCallsTable.purpose, "embed_memory"),
          eq(clerkInferenceCallsTable.firmId, firmId),
          eq(clerkInferenceCallsTable.promptVersion, "embed.v1+q"),
        ),
      )
      .orderBy(desc(clerkInferenceCallsTable.createdAt))
      .limit(1),
  );
  assert.ok(ledger, "query embed ledgered as firm-funded embed.v1+q");
});

test("client asker (SEC-03): only the asker's OWN cases surface", async () => {
  const embedder = fakeEmbedder();
  const memory = await computeAskMemory({
    firmId,
    question: `how do we stand on VAT right now? ${SALT}`,
    actorId: clientUserId,
    clientScoped: true,
    excludeCaseId: randomUUID(),
    embedder,
  });
  // The VAT case is the TOP similarity match but belongs to firm staff —
  // the createdBy pin must drop it and keep only the client's own case.
  assert.ok(memory, "the asker's own similar case still yields a note");
  assert.equal(memory.items.length, 1);
  assert.equal(memory.items[0].caseId, ownCase);
});

test("the current case never cites itself", async () => {
  const embedder = fakeEmbedder();
  const memory = await computeAskMemory({
    firmId,
    question: `how do we stand on VAT right now? ${SALT}`,
    actorId: firmUserId,
    clientScoped: false,
    excludeCaseId: vatCase,
    embedder,
  });
  assert.ok(
    !memory || memory.items.every((i) => i.caseId !== vatCase),
    "the excluded case id is never an item",
  );
});

test("a refused question is never cited — even when legacy-indexed", async () => {
  const embedder = fakeEmbedder();
  // Simulate a row indexed BEFORE the answered-only candidate filter
  // existed: hand-inserted at similarity 1 with the query, so it would be
  // the TOP match if only the index were consulted. The re-read's answered
  // check is the load-bearing wall.
  await runInBypassContext(async () => {
    await getDb()
      .insert(clerkMemoryEmbeddingsTable)
      .values({
        firmId,
        corpus: "ask_questions",
        refId: refusedCase,
        contentHash: `legacy-${SALT}`,
        model: embedder.model,
        embedding: QUERY_VECTOR,
      })
      .onConflictDoNothing();
  });
  const memory = await computeAskMemory({
    firmId,
    question: `how do we stand on VAT right now? ${SALT}`,
    actorId: firmUserId,
    clientScoped: false,
    excludeCaseId: randomUUID(),
    embedder,
  });
  assert.ok(memory, "the answered matches still yield a note");
  assert.ok(
    memory.items.every((i) => i.caseId !== refusedCase),
    "a refusal is no precedent",
  );
  assert.equal(
    memory.items[0].caseId,
    vatCase,
    "the top ANSWERED match leads",
  );
});

test("rail dark: no note, no embed call", async () => {
  const embedder = fakeEmbedder();
  await runInBypassContext(async () => {
    await getDb()
      .update(featureFlagsTable)
      .set({ enabled: false })
      .where(eq(featureFlagsTable.key, MEMORY_FLAG_KEY));
  });
  try {
    const memory = await computeAskMemory({
      firmId,
      question: `how do we stand on VAT right now? ${SALT}`,
      actorId: firmUserId,
      clientScoped: false,
      excludeCaseId: randomUUID(),
      embedder,
    });
    assert.equal(memory, undefined);
    assert.equal(embedder.calls, 0, "no spend while the rail is dark");
  } finally {
    await runInBypassContext(async () => {
      await getDb()
        .update(featureFlagsTable)
        .set({ enabled: true })
        .where(eq(featureFlagsTable.key, MEMORY_FLAG_KEY));
    });
  }
});

test("cold corpus (unknown model): no note, no embed spend", async () => {
  const embedder = fakeEmbedder();
  embedder.model = `fake-ask-cold-${SALT}`;
  const memory = await computeAskMemory({
    firmId,
    question: `how do we stand on VAT right now? ${SALT}`,
    actorId: firmUserId,
    clientScoped: false,
    excludeCaseId: randomUUID(),
    embedder,
  });
  assert.equal(memory, undefined, "an empty (firm, corpus, model) slice");
  assert.equal(
    embedder.calls,
    0,
    "the cold-corpus guard fires BEFORE the embed",
  );
});
