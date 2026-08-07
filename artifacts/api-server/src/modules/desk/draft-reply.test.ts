import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  firmsTable,
  partiesTable,
  invoicesTable,
  escalationsTable,
  errorCatalogueTable,
  submissionAttemptsTable,
  clerkInferenceCallsTable,
  clerkMemoryEmbeddingsTable,
  featureFlagsTable,
  EMBEDDING_DIMS,
} from "@workspace/db";
import {
  copiesExampleSpecifics,
  draftEscalationReply,
  sendEscalationReply,
} from "./draft-reply.ts";
import { CLERK_FLAG_KEY, sha256 } from "../clerk/gateway.ts";
import { indexMemoryBatch, MEMORY_FLAG_KEY } from "../clerk/memory.ts";
import { setFlag } from "../flags/flags.ts";
import type { CompletionRequest, MemoryEmbedder } from "../clerk/gateway.ts";
import {
  fakeGateway,
  restoreClerkFlag,
  saveAndEnableClerkFlag,
} from "../clerk/test-support.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Drafted escalation replies (exhaust idea #5). Pinned invariants:
//  - the draft is grounded: catalogue cause/fix and real attempt history reach
//  the model as trusted facts, the client's message only inside the fence;
//  - kill switch off or discarded output falls back to the deterministic
//  template — a draft request never errors for model reasons;
//  - nothing reaches the client until the operator sends: sendEscalationReply
//  is the only writer, it acknowledges an OPEN escalation and leaves any
//  other status alone.

const SALT = makeRunSalt();
const CODE = `REPLY_KNOWN_${SALT.toUpperCase()}`;

const firmId = randomUUID();
const partyId = randomUUID();
const invoiceId = randomUUID();
const escalationId = randomUUID();
const bareEscalationId = randomUUID();
const actorId = randomUUID();

before(async () => {
  await saveAndEnableClerkFlag();
  const db = getDb();
  await db.insert(firmsTable).values({ id: firmId, name: `Reply Firm ${SALT}` });
  await db.insert(partiesTable).values({
    id: partyId,
    type: "client_business",
    legalName: `Reply Party ${SALT}`,
  });
  await db.insert(invoicesTable).values({
    id: invoiceId,
    firmId,
    supplierPartyId: partyId,
    buyerPartyId: partyId,
    invoiceNumber: `REPLY-${SALT}`,
    issueDate: "2026-07-01",
  });
  await db
    .insert(errorCatalogueTable)
    .values({
      code: CODE,
      cause: `test cause ${SALT}`,
      fix: `test fix ${SALT}`,
      retriable: true,
    })
    .onConflictDoNothing();
  await db.insert(submissionAttemptsTable).values({
    invoiceId,
    rail: "rail_primary",
    attemptNo: 1,
    idempotencyKey: `reply-${SALT}-1`,
    status: "rejected",
    errorCode: CODE,
  });
  await db.insert(escalationsTable).values([
    {
      // errorCode deliberately unset: the draft must recover it from the
      // invoice's latest attempt.
      id: escalationId,
      invoiceId,
      firmId,
      clientPartyId: partyId,
      reason: `Submission keeps failing, please help! ${SALT}`,
    },
    {
      id: bareEscalationId,
      invoiceId,
      firmId,
      clientPartyId: partyId,
      reason: `Second escalation ${SALT}`,
    },
  ]);
});

after(async () => {
  await restoreClerkFlag();
});

test("kill switch off: the template answers, grounded in the catalogue", async () => {
  await setFlag(CLERK_FLAG_KEY, false);
  try {
    let calls = 0;
    const draft = await draftEscalationReply(
      escalationId,
      fakeGateway(() => {
        calls += 1;
        return JSON.stringify({ reply: "should not be called" });
      }),
    );
    assert.equal(draft.source, "template");
    assert.equal(draft.errorCode, CODE, "code recovered from attempt history");
    assert.ok(draft.draft.includes(`test cause ${SALT}`));
    assert.ok(draft.draft.includes(`test fix ${SALT}`));
    assert.equal(calls, 0, "dark switch = no provider call");
  } finally {
    await setFlag(CLERK_FLAG_KEY, true);
  }
});

test("clerk draft: facts travel plain, the client's message only fenced", async () => {
  const calls: CompletionRequest[] = [];
  const draft = await draftEscalationReply(
    escalationId,
    fakeGateway((req) => {
      calls.push(req);
      return JSON.stringify({ reply: `Drafted for the client ${SALT}` });
    }),
  );
  assert.equal(draft.source, "clerk");
  assert.equal(draft.draft, `Drafted for the client ${SALT}`);
  const user = calls[0].user as string;
  assert.ok(user.includes(`test cause ${SALT}`), "catalogue grounding");
  assert.ok(user.includes("-----BEGIN ESCALATION-----"), "fenced message");
});

test("discarded output falls back to the template, never an error", async () => {
  const draft = await draftEscalationReply(
    escalationId,
    fakeGateway(() => "not json"),
  );
  assert.equal(draft.source, "template");
  assert.ok(draft.draft.length > 0, "a sendable reply either way");
});

test("no gateway at all (unconfigured provider) still answers with the template", async () => {
  const draft = await draftEscalationReply(escalationId, null);
  assert.equal(draft.source, "template");
  assert.ok(draft.draft.includes(`test cause ${SALT}`));
});

test("a missing escalation is a clean 404", async () => {
  await assert.rejects(
    draftEscalationReply(randomUUID(), fakeGateway(() => "unused")),
    (err: Error & { status?: number }) => err.status === 404,
  );
});

test("send: writes the reply and acknowledges an open escalation", async () => {
  const sent = await sendEscalationReply(
    escalationId,
    `  We are on it. ${SALT}  `,
    actorId,
  );
  assert.equal(sent.operatorReply, `We are on it. ${SALT}`, "trimmed");
  assert.equal(sent.status, "acknowledged");
  assert.ok(sent.repliedAt);

  const [row] = await getDb()
    .select()
    .from(escalationsTable)
    .where(eq(escalationsTable.id, escalationId));
  assert.equal(row.operatorReply, `We are on it. ${SALT}`);
});

test("send: a non-open escalation keeps its status", async () => {
  await getDb()
    .update(escalationsTable)
    .set({ status: "resolved" })
    .where(eq(escalationsTable.id, bareEscalationId));
  const sent = await sendEscalationReply(
    bareEscalationId,
    `Closing note ${SALT}`,
    actorId,
  );
  assert.equal(sent.status, "resolved", "resolved stays resolved");
  assert.equal(sent.operatorReply, `Closing note ${SALT}`);
});

test("send: an empty or oversized reply is refused", async () => {
  await assert.rejects(
    sendEscalationReply(escalationId, "   ", actorId),
    (err: Error & { code?: string; status?: number }) =>
      err.code === "BAD_REPLY" && err.status === 400,
  );
  await assert.rejects(
    sendEscalationReply(escalationId, "x".repeat(2001), actorId),
    (err: Error & { code?: string; status?: number }) =>
      err.code === "BAD_REPLY" && err.status === 400,
  );
});

test("reply memory: same-firm same-code sent replies ride along fenced", async () => {
  // A same-code sent reply belonging to ANOTHER firm must never be borrowed.
  const foreignFirm = randomUUID();
  const foreignParty = randomUUID();
  const foreignInvoice = randomUUID();
  const db = getDb();
  await db
    .insert(firmsTable)
    .values({ id: foreignFirm, name: `Reply Foreign ${SALT}` });
  await db.insert(partiesTable).values({
    id: foreignParty,
    type: "client_business",
    legalName: `Reply Foreign Party ${SALT}`,
  });
  await db.insert(invoicesTable).values({
    id: foreignInvoice,
    firmId: foreignFirm,
    supplierPartyId: foreignParty,
    buyerPartyId: foreignParty,
    invoiceNumber: `REPLY-F-${SALT}`,
    issueDate: "2026-07-01",
  });
  await db.insert(escalationsTable).values({
    invoiceId: foreignInvoice,
    firmId: foreignFirm,
    clientPartyId: foreignParty,
    reason: `foreign ${SALT}`,
    errorCode: CODE,
    operatorReply: `FOREIGN reply ${SALT}`,
    repliedAt: new Date(),
    status: "resolved",
  });

  const calls: CompletionRequest[] = [];
  // The fake reply deliberately copies NOTHING from the example — a salted
  // reply here would (correctly) trip the copy guard and mask the memory.
  const gw = fakeGateway((req) => {
    calls.push(req);
    return JSON.stringify({
      reply: "We reviewed this and will follow up shortly.",
    });
  });
  const first = await draftEscalationReply(escalationId, gw);
  assert.equal(first.viaExample, false, "another firm's reply never borrowed");
  assert.ok(!(calls[0].user as string).includes("PAST_REPLY"));

  // A same-firm sent reply for the same code: rides along fenced, the system
  // prompt gains the style-only guardrails, and the ledger records the
  // variant prompt version so the exemplar's effect stays measurable.
  await db.insert(escalationsTable).values({
    invoiceId,
    firmId,
    clientPartyId: partyId,
    reason: `past escalation ${SALT}`,
    errorCode: CODE,
    operatorReply: `Past reply ${SALT}`,
    repliedAt: new Date(),
    status: "resolved",
  });
  const second = await draftEscalationReply(escalationId, gw);
  assert.equal(second.viaExample, true);
  assert.equal(second.source, "clerk");
  const user = calls[1].user as string;
  assert.ok(user.includes("-----BEGIN PAST_REPLY-----"), "example fenced");
  assert.ok(user.includes(`Past reply ${SALT}`));
  assert.ok(
    calls[1].system.includes("STYLE example"),
    "style-only guardrail in the system prompt",
  );
  const [ledger] = await runInBypassContext(() =>
    getDb()
      .select({ promptVersion: clerkInferenceCallsTable.promptVersion })
      .from(clerkInferenceCallsTable)
      .where(eq(clerkInferenceCallsTable.purpose, "draft_reply"))
      .orderBy(desc(clerkInferenceCallsTable.createdAt))
      .limit(1),
  );
  assert.equal(ledger.promptVersion, "draft-reply.v1+ex1");

  // The deterministic backstop: a draft that verbatim-copies the example's
  // specifics is discarded in favour of the template.
  const copying = await draftEscalationReply(
    escalationId,
    fakeGateway(() =>
      JSON.stringify({ reply: `As before: Past reply ${SALT}` }),
    ),
  );
  assert.equal(copying.source, "template");
  assert.equal(copying.viaExample, false);
});

test("semantic reply memory: similar situations preferred over exact code, firm-pinned, self-skipped", async () => {
  const db = getDb();
  // Light the memory flag globally (seeded dark; re-darkened in finally).
  await db
    .insert(featureFlagsTable)
    .values({ key: MEMORY_FLAG_KEY, enabled: true, releaseTag: "R3" })
    .onConflictDoUpdate({
      target: featureFlagsTable.key,
      set: { enabled: true },
    });
  try {
    // A same-firm replied escalation with NO error code — reachable only
    // semantically — plus a foreign-firm ringer whose reason embeds to the
    // exact query vector (similarity 1): the firm wall must beat similarity.
    const similarId = randomUUID();
    await db.insert(escalationsTable).values({
      id: similarId,
      invoiceId,
      firmId,
      clientPartyId: partyId,
      reason: `VAT registration bounced ${SALT}`,
      operatorReply: `We re-registered the VAT profile and resubmitted. ${SALT}`,
      repliedAt: new Date(),
      status: "resolved",
    });
    const ringerFirm = randomUUID();
    const ringerParty = randomUUID();
    const ringerInvoice = randomUUID();
    await db
      .insert(firmsTable)
      .values({ id: ringerFirm, name: `Ringer Firm ${SALT}` });
    await db.insert(partiesTable).values({
      id: ringerParty,
      type: "client_business",
      legalName: `Ringer Party ${SALT}`,
    });
    await db.insert(invoicesTable).values({
      id: ringerInvoice,
      firmId: ringerFirm,
      supplierPartyId: ringerParty,
      buyerPartyId: ringerParty,
      invoiceNumber: `RINGER-${SALT}`,
      issueDate: "2026-07-01",
    });
    await db.insert(escalationsTable).values({
      invoiceId: ringerInvoice,
      firmId: ringerFirm,
      clientPartyId: ringerParty,
      reason: `ringer twin ${SALT}`,
      operatorReply: `RINGER reply ${SALT}`,
      repliedAt: new Date(),
      status: "resolved",
    });

    // Deterministic embedder: the current escalation's reason (the query
    // AND its own indexed row) and the ringer's reason share axis 0; the
    // similar row sits at cosine 0.8; every other reason is orthogonal
    // (below the similarity floor).
    const axis = (i: number): number[] => {
      const v = new Array<number>(EMBEDDING_DIMS).fill(0);
      v[i] = 1;
      return v;
    };
    let embeds = 0;
    const embedder: MemoryEmbedder = {
      model: `fake-embed-${SALT}`,
      async embed(texts) {
        embeds += 1;
        return {
          vectors: texts.map((t) => {
            if (t.includes("VAT registration bounced")) {
              const v = new Array<number>(EMBEDDING_DIMS).fill(0);
              v[0] = 0.8;
              v[1] = 0.6;
              return v;
            }
            if (
              t.includes("Submission keeps failing") ||
              t.includes("ringer twin")
            ) {
              return axis(0);
            }
            return axis(2);
          }),
          promptTokens: texts.length * 3,
        };
      },
    };

    // The generalized indexer picks up the escalation_replies corpus end to
    // end: this suite's four replied escalations for our firm plus the
    // ringer's one (the foreign firm from the exact-code test stays outside
    // the pin and is never embedded or charged).
    const pass = await indexMemoryBatch(embedder, 20, {
      onlyFirmIds: [firmId, ringerFirm],
    });
    assert.equal(pass.indexed, 5, "all replied escalations indexed");
    assert.equal(pass.skippedFirms, 0);
    assert.equal(embeds, 2, "one embedding call per firm");
    const [indexedRow] = await runInBypassContext(() =>
      getDb()
        .select()
        .from(clerkMemoryEmbeddingsTable)
        .where(
          and(
            eq(clerkMemoryEmbeddingsTable.firmId, firmId),
            eq(clerkMemoryEmbeddingsTable.corpus, "escalation_replies"),
            eq(clerkMemoryEmbeddingsTable.refId, similarId),
          ),
        ),
    );
    assert.ok(indexedRow, "similar row indexed under escalation_replies");
    assert.equal(
      indexedRow.contentHash,
      sha256(`VAT registration bounced ${SALT}`),
      "provenance hash over the embedded reason",
    );
    assert.equal(indexedRow.model, `fake-embed-${SALT}`);
    const again = await indexMemoryBatch(embedder, 20, {
      onlyFirmIds: [firmId, ringerFirm],
    });
    assert.equal(again.indexed, 0, "anti-join: nothing re-embedded");
    assert.equal(embeds, 2, "no embedding call on an empty pass");

    // The draft: the fake reply copies nothing from the example (the copy
    // guard would otherwise correctly discard it and mask the retrieval).
    const calls: CompletionRequest[] = [];
    const gw = fakeGateway((req) => {
      calls.push(req);
      return JSON.stringify({
        reply:
          "Thanks for flagging this — we have handled this before and will resubmit shortly.",
      });
    });
    const draft = await draftEscalationReply(escalationId, gw, embedder);
    assert.equal(draft.source, "clerk");
    assert.equal(draft.viaExample, true, "semantic exemplar rode along");
    assert.equal(embeds, 3, "the query reason was embedded once");
    const user = calls[0].user as string;
    assert.ok(user.includes("-----BEGIN PAST_REPLY-----"), "example fenced");
    assert.ok(
      user.includes(`We re-registered the VAT profile and resubmitted. ${SALT}`),
      "the SIMILAR reply was chosen — self at similarity 1 skipped",
    );
    assert.ok(
      !user.includes(`RINGER reply ${SALT}`),
      "the foreign twin never crosses the firm wall",
    );
    assert.ok(
      !user.includes(`Past reply ${SALT}`),
      "semantic retrieval preferred over the exact-code fallback",
    );
    const [memoryLedger] = await runInBypassContext(() =>
      getDb()
        .select({ promptVersion: clerkInferenceCallsTable.promptVersion })
        .from(clerkInferenceCallsTable)
        .where(eq(clerkInferenceCallsTable.purpose, "draft_reply"))
        .orderBy(desc(clerkInferenceCallsTable.createdAt))
        .limit(1),
    );
    assert.equal(memoryLedger.promptVersion, "draft-reply.v1+mx1");
    const [embedLedger] = await runInBypassContext(() =>
      getDb()
        .select({
          promptVersion: clerkInferenceCallsTable.promptVersion,
          firmId: clerkInferenceCallsTable.firmId,
        })
        .from(clerkInferenceCallsTable)
        .where(eq(clerkInferenceCallsTable.purpose, "embed_memory"))
        .orderBy(desc(clerkInferenceCallsTable.createdAt))
        .limit(1),
    );
    assert.equal(
      embedLedger.promptVersion,
      "embed.v1+q",
      "query embeds carry their own ledger cohort",
    );
    assert.equal(embedLedger.firmId, firmId, "the query embed is firm-funded");

    // Rail dark: the exact-code exemplar answers, and no embed call is made
    // (the gate short-circuits before any embedder is even resolved).
    await setFlag(MEMORY_FLAG_KEY, false);
    const fallback = await draftEscalationReply(escalationId, gw);
    assert.equal(fallback.viaExample, true);
    const fallbackUser = calls[1].user as string;
    assert.ok(
      fallbackUser.includes(`Past reply ${SALT}`),
      "rail dark: the exact-code exemplar rides instead",
    );
    assert.equal(embeds, 3, "no embed spend while the rail is dark");
    const [exLedger] = await runInBypassContext(() =>
      getDb()
        .select({ promptVersion: clerkInferenceCallsTable.promptVersion })
        .from(clerkInferenceCallsTable)
        .where(eq(clerkInferenceCallsTable.purpose, "draft_reply"))
        .orderBy(desc(clerkInferenceCallsTable.createdAt))
        .limit(1),
    );
    assert.equal(exLedger.promptVersion, "draft-reply.v1+ex1");
  } finally {
    await setFlag(MEMORY_FLAG_KEY, false);
  }
});

test("copiesExampleSpecifics: identifiers and long runs trip, style does not", () => {
  const example =
    "Thank you for raising invoice INV-2201 for NGN 450000.00. The TIN mismatch on attempt 2 has been corrected and we will resubmit shortly.";
  // Copying the other client's invoice number trips.
  assert.equal(
    copiesExampleSpecifics("Your invoice INV-2201 is being handled.", example, "TIN_MISMATCH"),
    true,
  );
  // The shared catalogue code never trips (both cases legitimately name it).
  assert.equal(
    copiesExampleSpecifics(
      "The code TIN-04510 was returned; we are on it.",
      "Earlier we saw TIN-04510 too.",
      "TIN-04510",
    ),
    false,
  );
  // A 40+ character verbatim run trips even without identifiers.
  const prose =
    "we have reviewed the submission history and spoken to the rail operator about the rejection";
  assert.equal(
    copiesExampleSpecifics(`Dear client, ${prose}.`, `Note: ${prose}!`, null),
    true,
  );
  // Following tone and structure without copying stays clean.
  assert.equal(
    copiesExampleSpecifics(
      "Thanks for flagging this — the TIN issue is fixed and we will resubmit today.",
      example,
      null,
    ),
    false,
  );
});
