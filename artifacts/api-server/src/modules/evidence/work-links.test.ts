import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  evidenceRequestsTable,
  getDb,
  membershipsTable,
  runInBypassContext,
  runRequestContext,
  workItemsTable,
  type EvidenceRequest,
} from "@workspace/db";
import workRouter from "../../routes/work";
import {
  appFor,
  closeAllServers,
  JSON_HEADERS,
  listen,
} from "../../test-helpers/route-harness";
import { clientPrincipal, firmPrincipal } from "../../test-helpers/principals";
import { getWorkItemView, listWorkItemViews } from "../work/service";
import { cleanEvidenceFile, evidenceFixture } from "./test-fixtures";
import { syncEvidenceWork } from "./work-links";

let fixture: Awaited<ReturnType<typeof evidenceFixture>>;
let staffBase: string;
let clientBase: string;
before(async () => {
  fixture = await evidenceFixture();
  staffBase = await listen(
    appFor(
      firmPrincipal(fixture.firmId, { userId: fixture.ownerId }),
      workRouter,
    ),
  );
  clientBase = await listen(
    appFor(
      clientPrincipal(fixture.firmId, fixture.clientPartyId, {
        userId: fixture.clientUserId,
      }),
      workRouter,
    ),
  );
});
after(closeAllServers);

async function workFor(request: EvidenceRequest) {
  const rows = await getDb()
    .select()
    .from(workItemsTable)
    .where(
      and(
        eq(workItemsTable.firmId, request.firmId),
        eq(workItemsTable.clientRequestId, request.id),
      ),
    );
  assert.equal(rows.length, 1);
  return rows[0];
}

test("sync creates one scoped work item and repeated sync leaves its version unchanged", async () => {
  const request = await fixture.request({
    dueAt: new Date("2099-06-01T12:00:00Z"),
  });
  await syncEvidenceWork(request);
  const first = await workFor(request);
  await Promise.all([syncEvidenceWork(request), syncEvidenceWork(request)]);
  const replay = await workFor(request);
  assert.equal(first.id, replay.id);
  assert.equal(replay.version, first.version);
  assert.equal(first.entityType, "evidence_request");
  assert.equal(first.entityId, request.id);
  assert.equal(first.clientPartyId, fixture.clientPartyId);
  assert.equal(first.assignedTo, fixture.ownerId);
  assert.equal(first.createdBy, fixture.ownerId);
  assert.equal(first.title, `Document request: ${request.title}`);
  assert.equal(first.href, `/evidence?request=${request.id}`);
  assert.equal(first.dueAt?.toISOString(), request.dueAt?.toISOString());

  const client = clientPrincipal(fixture.firmId, fixture.clientPartyId);
  const visible = await listWorkItemViews(client, { limit: 100 });
  assert.equal(visible.filter((row) => row.id === first.id).length, 1);
  await assert.rejects(
    getWorkItemView(
      clientPrincipal(fixture.firmId, fixture.siblingPartyId),
      first.id,
    ),
  );
  await assert.rejects(
    getWorkItemView(firmPrincipal(fixture.otherFirmId), first.id),
  );
});

test("all evidence statuses map to work and stale input cannot revert the persisted request", async () => {
  const request = await fixture.request();
  const file = await cleanEvidenceFile(request);
  for (const [status, expected] of [
    ["requested", "open"],
    ["uploaded", "in_progress"],
    ["needs_changes", "blocked"],
    ["accepted", "done"],
    ["cancelled", "done"],
    ["requested", "open"],
  ] as const) {
    await getDb()
      .update(evidenceRequestsTable)
      .set({
        status,
        latestFileId: status === "requested" ? null : file.id,
        acceptedFileId: status === "accepted" ? file.id : null,
      })
      .where(eq(evidenceRequestsTable.id, request.id));
    await syncEvidenceWork(request);
    const item = await workFor(request);
    assert.equal(item.status, expected);
    assert.equal(item.completedAt !== null, expected === "done");
  }
  await getDb()
    .update(evidenceRequestsTable)
    .set({ title: "Updated title", dueAt: null })
    .where(eq(evidenceRequestsTable.id, request.id));
  await syncEvidenceWork(request);
  assert.equal(
    (await workFor(request)).title,
    "Document request: Updated title",
  );
});

test("sync preserves request transaction rollback and rejects a forged firm or client scope", async () => {
  let id = "";
  await assert.rejects(
    runInBypassContext(async () => {
      const request = await fixture.request();
      id = request.id;
      await syncEvidenceWork(request);
      throw new Error("rollback evidence request");
    }),
    /rollback evidence request/,
  );
  assert.equal(
    (
      await getDb()
        .select()
        .from(workItemsTable)
        .where(eq(workItemsTable.clientRequestId, id))
    ).length,
    0,
  );
  const request = await fixture.request();
  await assert.rejects(
    syncEvidenceWork({ ...request, firmId: fixture.otherFirmId }),
  );
  await assert.rejects(
    syncEvidenceWork({ ...request, clientPartyId: fixture.siblingPartyId }),
  );
  await assert.rejects(
    runRequestContext({ bypass: false, firmId: fixture.otherFirmId }, () =>
      syncEvidenceWork(request),
    ),
  );
});

test("a colliding unrelated work item is not adopted or overwritten", async () => {
  const request = await fixture.request();
  await getDb().insert(workItemsTable).values({
    firmId: fixture.firmId,
    clientPartyId: fixture.siblingPartyId,
    clientRequestId: request.id,
    title: "Unrelated task",
    createdBy: fixture.ownerId,
  });
  await assert.rejects(
    syncEvidenceWork(request),
    /conflicts with an existing work item/,
  );
  assert.equal((await workFor(request)).title, "Unrelated task");
});

test("another firm's matching work request id neither collides nor changes", async () => {
  const request = await fixture.request();
  const [foreign] = await getDb()
    .insert(workItemsTable)
    .values({
      firmId: fixture.otherFirmId,
      clientPartyId: fixture.clientPartyId,
      clientRequestId: request.id,
      title: "Other firm's task",
      createdBy: fixture.foreignUserId,
    })
    .returning();
  await syncEvidenceWork(request);
  assert.notEqual((await workFor(request)).id, foreign.id);
  const [unchanged] = await getDb()
    .select()
    .from(workItemsTable)
    .where(eq(workItemsTable.id, foreign.id));
  assert.equal(unchanged.title, foreign.title);
  assert.equal(unchanged.version, foreign.version);
});

test("a departed owner becomes explicitly unassigned without blocking request transitions", async () => {
  const isolated = await evidenceFixture();
  const request = await isolated.request();
  await syncEvidenceWork(request);
  assert.equal((await workFor(request)).assignedTo, isolated.ownerId);
  await getDb()
    .delete(membershipsTable)
    .where(
      and(
        eq(membershipsTable.firmId, isolated.firmId),
        eq(membershipsTable.userId, isolated.ownerId),
      ),
    );
  const file = await cleanEvidenceFile(request);
  for (const status of ["uploaded", "needs_changes", "accepted"] as const) {
    await getDb()
      .update(evidenceRequestsTable)
      .set({
        status,
        latestFileId: file.id,
        acceptedFileId: status === "accepted" ? file.id : null,
      })
      .where(eq(evidenceRequestsTable.id, request.id));
    await syncEvidenceWork(request);
    assert.equal((await workFor(request)).assignedTo, null);
  }
  const [saved] = await getDb()
    .select()
    .from(evidenceRequestsTable)
    .where(eq(evidenceRequestsTable.id, request.id));
  assert.equal(saved.ownerId, isolated.ownerId);
  await getDb().insert(membershipsTable).values({
    firmId: isolated.firmId,
    userId: isolated.foreignUserId,
    role: "firm_staff",
  });
  const dueAt = new Date("2099-07-01T12:00:00Z");
  await getDb()
    .update(evidenceRequestsTable)
    .set({
      ownerId: isolated.foreignUserId,
      dueAt,
    })
    .where(eq(evidenceRequestsTable.id, request.id));
  await syncEvidenceWork(request);
  const reassigned = await workFor(request);
  assert.equal(reassigned.assignedTo, isolated.foreignUserId);
  assert.equal(reassigned.dueAt?.getTime(), dueAt.getTime());
});

test("work routes reject evidence forgery and manual projections, but allow comments and priority", async () => {
  const request = await fixture.request();
  await syncEvidenceWork(request);
  const item = await workFor(request);
  for (const entityType of [
    "evidence_request",
    " evidence_request ",
    "EVIDENCE_REQUEST",
  ]) {
    const response = await fetch(`${staffBase}/work-items`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        clientRequestId: randomUUID(),
        title: "Forged request",
        entityType,
        entityId: request.id,
      }),
    });
    assert.equal(response.status, 403);
  }
  const collision = await fetch(`${staffBase}/work-items`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      clientRequestId: request.id,
      title: "Adopt existing evidence",
    }),
  });
  assert.equal(collision.status, 403);
  for (const base of [staffBase, clientBase]) {
    for (const patch of [
      { status: "done" },
      { assignedTo: fixture.clientUserId },
      { assignedTo: null },
      { title: "Changed" },
      { dueAt: null },
    ]) {
      const response = await fetch(`${base}/work-items/${item.id}`, {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify({ version: item.version, ...patch }),
      });
      assert.equal(response.status, 403);
    }
    const rewrite = await fetch(`${base}/work-items/${item.id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        version: item.version,
        entityType: "manual",
        entityId: randomUUID(),
      }),
    });
    assert.equal(rewrite.status, 400);
  }
  const priority = await fetch(`${staffBase}/work-items/${item.id}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({ version: item.version, priority: "high" }),
  });
  assert.equal(priority.status, 200);
  const commentRequestId = randomUUID();
  for (let replay = 0; replay < 2; replay++) {
    const response = await fetch(
      `${clientBase}/work-items/${item.id}/comments`,
      {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          clientRequestId: commentRequestId,
          body: "Requested document is being prepared",
        }),
      },
    );
    assert.equal(response.status, 201);
  }
  const comments = await fetch(`${clientBase}/work-items/${item.id}/comments`);
  assert.equal(((await comments.json()) as unknown[]).length, 1);
  assert.equal((await workFor(request)).status, "open");
});
