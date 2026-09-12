import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  evidenceEventsTable,
  evidenceRequestsTable,
  getDb,
  membershipsTable,
  messagesTable,
  runInBypassContext,
  type EvidenceRequest,
} from "@workspace/db";
import { cleanEvidenceFile, evidenceFixture } from "./test-fixtures";
import { notifyEvidenceTransition } from "./work-links";

async function insertEvent(request: EvidenceRequest, action: string) {
  const [event] = await getDb()
    .insert(evidenceEventsTable)
    .values({
      firmId: request.firmId,
      requestId: request.id,
      action,
      actorId: request.createdBy,
      clientRequestId: randomUUID(),
      requestHash: randomUUID(),
    })
    .returning();
  return event;
}

async function notifications(requestId: string) {
  return getDb()
    .select()
    .from(messagesTable)
    .where(
      and(
        eq(messagesTable.entityType, "evidence_request"),
        eq(messagesTable.entityId, requestId),
      ),
    );
}

test("an undated request reaches its client once across event notification replays", async () => {
  const fixture = await evidenceFixture();
  const request = await fixture.request();
  assert.equal(request.dueAt, null);
  const event = await runInBypassContext(async () => {
    const event = await insertEvent(request, "requested");
    await notifyEvidenceTransition(request, event);
    await notifyEvidenceTransition(request, event);
    return event;
  });
  await runInBypassContext(() => notifyEvidenceTransition(request, event));
  const messages = await notifications(request.id);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, event.id);
  assert.equal(messages[0].templateKey, "document_request_created");
  assert.equal(messages[0].recipientPartyId, fixture.clientPartyId);
  assert.equal(messages[0].recipientUserId, null);
  assert.equal(messages[0].channel, "in_app");
  assert.equal(messages[0].providerMessageId, null);
  assert.ok(!JSON.stringify(messages).includes(request.title));
  assert.ok(!JSON.stringify(messages).includes(request.description!));
});

test("uploads notify only the staff owner; review outcomes notify only the client, including accepted then cancelled", async () => {
  const fixture = await evidenceFixture();
  const request = await fixture.request();
  const file = await cleanEvidenceFile(request);
  for (const status of [
    "uploaded",
    "needs_changes",
    "uploaded",
    "accepted",
    "cancelled",
  ] as const) {
    await runInBypassContext(async () => {
      const [current] = await getDb()
        .update(evidenceRequestsTable)
        .set({
          status,
          latestFileId: file.id,
          acceptedFileId: status === "accepted" ? file.id : null,
        })
        .where(eq(evidenceRequestsTable.id, request.id))
        .returning();
      const event = await insertEvent(current, status);
      await notifyEvidenceTransition(current, event);
      await notifyEvidenceTransition(current, event);
    });
  }
  const messages = await notifications(request.id);
  assert.equal(messages.length, 5);
  const uploaded = messages.filter(
    (message) => message.templateKey === "document_request_uploaded",
  );
  assert.equal(
    uploaded.length,
    2,
    "a fresh upload event is meaningful even after an earlier upload",
  );
  assert.ok(
    uploaded.every(
      (message) =>
        message.recipientUserId === fixture.ownerId &&
        message.recipientPartyId === null,
    ),
  );
  const reviewed = messages.filter(
    (message) => message.templateKey !== "document_request_uploaded",
  );
  assert.deepEqual(reviewed.map((message) => message.templateKey).sort(), [
    "document_request_accepted",
    "document_request_cancelled",
    "document_request_needs_changes",
  ]);
  assert.ok(
    reviewed.every(
      (message) =>
        message.recipientPartyId === fixture.clientPartyId &&
        message.recipientUserId === null,
    ),
  );
});

test("notification writes roll back with their event and reject forged tenant or client scope", async () => {
  const fixture = await evidenceFixture();
  const request = await fixture.request();
  await assert.rejects(
    runInBypassContext(async () => {
      const event = await insertEvent(request, "requested");
      await notifyEvidenceTransition(request, event);
      throw new Error("rollback transition");
    }),
    /rollback transition/,
  );
  assert.equal((await notifications(request.id)).length, 0);
  const event = await insertEvent(request, "requested");
  await assert.rejects(
    runInBypassContext(() =>
      notifyEvidenceTransition(
        { ...request, firmId: fixture.otherFirmId },
        event,
      ),
    ),
  );
  await assert.rejects(
    runInBypassContext(() =>
      notifyEvidenceTransition(
        { ...request, clientPartyId: fixture.siblingPartyId },
        event,
      ),
    ),
  );
  assert.equal((await notifications(request.id)).length, 0);
});

test("departed owners and missing client members never produce invented recipients; metadata events stay quiet", async () => {
  const fixture = await evidenceFixture();
  const request = await fixture.request();
  await getDb()
    .delete(membershipsTable)
    .where(
      and(
        eq(membershipsTable.firmId, fixture.firmId),
        eq(membershipsTable.userId, fixture.ownerId),
      ),
    );
  await runInBypassContext(async () => {
    await notifyEvidenceTransition(
      request,
      await insertEvent(request, "uploaded"),
    );
    await notifyEvidenceTransition(
      request,
      await insertEvent(request, "metadata_updated"),
    );
    await notifyEvidenceTransition(
      request,
      await insertEvent(request, "needs_changes"),
    );
  });
  const messages = await notifications(request.id);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].recipientPartyId, fixture.clientPartyId);
  await getDb()
    .delete(membershipsTable)
    .where(
      and(
        eq(membershipsTable.firmId, fixture.firmId),
        eq(membershipsTable.clientPartyId, fixture.clientPartyId),
      ),
    );
  await runInBypassContext(() =>
    insertEvent(request, "cancelled").then((event) =>
      notifyEvidenceTransition(request, event),
    ),
  );
  assert.equal((await notifications(request.id)).length, 1);
});
