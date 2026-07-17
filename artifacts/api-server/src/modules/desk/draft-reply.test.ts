import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  getDb,
  firmsTable,
  partiesTable,
  invoicesTable,
  escalationsTable,
  errorCatalogueTable,
  submissionAttemptsTable,
} from "@workspace/db";
import { draftEscalationReply, sendEscalationReply } from "./draft-reply.ts";
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
