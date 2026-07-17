import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
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
} from "@workspace/db";
import {
  copiesExampleSpecifics,
  draftEscalationReply,
  sendEscalationReply,
} from "./draft-reply.ts";
import { CLERK_FLAG_KEY } from "../clerk/gateway.ts";
import { setFlag } from "../flags/flags.ts";
import type { CompletionRequest } from "../clerk/gateway.ts";
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
