import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  engagementsTable,
  firmsTable,
  getDb,
  membershipsTable,
  partiesTable,
  usersTable,
  workItemCommentsTable,
  workItemsTable,
} from "@workspace/db";
import workRouter from "../../routes/work.ts";
import {
  appFor,
  closeAllServers,
  JSON_HEADERS,
  listen,
} from "../../test-helpers/route-harness.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";
import {
  clientPrincipal,
  firmPrincipal,
} from "../../test-helpers/principals.ts";

const salt = makeRunSalt();
const firmId = randomUUID();
const staffId = randomUUID();
const clientUserAId = randomUUID();
const clientUserBId = randomUUID();
const clientAId = randomUUID();
const clientBId = randomUUID();
const staff = firmPrincipal(firmId, {
  userId: staffId,
  role: "firm_staff",
});
const clientA = clientPrincipal(firmId, clientAId, {
  userId: clientUserAId,
});

let staffBase = "";
let clientBase = "";
let itemAId = "";
let itemBId = "";
let commentId = "";

before(async () => {
  const db = getDb();
  await db.insert(usersTable).values([
    {
      id: staffId,
      email: `work-staff-${salt}@test.local`,
      fullName: "Work Staff",
    },
    {
      id: clientUserAId,
      email: `work-client-a-${salt}@test.local`,
      fullName: "Client A User",
    },
    {
      id: clientUserBId,
      email: `work-client-b-${salt}@test.local`,
      fullName: "Client B User",
    },
  ]);
  await db.insert(firmsTable).values({
    id: firmId,
    name: `Work Firm ${salt}`,
  });
  await db.insert(partiesTable).values([
    {
      id: clientAId,
      type: "client_business",
      legalName: `Work Client A ${salt}`,
    },
    {
      id: clientBId,
      type: "client_business",
      legalName: `Work Client B ${salt}`,
    },
  ]);
  await db.insert(engagementsTable).values([
    {
      firmId,
      clientPartyId: clientAId,
      type: "retainer",
      title: "Client A engagement",
    },
    {
      firmId,
      clientPartyId: clientBId,
      type: "retainer",
      title: "Client B engagement",
    },
  ]);
  await db.insert(membershipsTable).values([
    { userId: staffId, firmId, role: "firm_staff" },
    {
      userId: clientUserAId,
      firmId,
      role: "client_user",
      clientPartyId: clientAId,
    },
    {
      userId: clientUserBId,
      firmId,
      role: "client_user",
      clientPartyId: clientBId,
    },
  ]);
  staffBase = await listen(appFor(staff, workRouter));
  clientBase = await listen(appFor(clientA, workRouter));
});

after(async () => {
  await closeAllServers();
});

async function createWork(
  base: string,
  body: Record<string, unknown>,
): Promise<{ response: Response; payload: Record<string, unknown> }> {
  const response = await fetch(`${base}/work-items`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  return {
    response,
    payload: (await response.json()) as Record<string, unknown>,
  };
}

test("work creation and comments are idempotent across retries", async () => {
  const requestId = randomUUID();
  const input = {
    clientRequestId: requestId,
    clientPartyId: clientAId,
    title: "Confirm VAT return",
    description: "Resolve the variance before filing.",
    priority: "high",
    assignedTo: staffId,
  };
  const first = await createWork(staffBase, input);
  const replay = await createWork(staffBase, input);
  assert.equal(first.response.status, 201);
  assert.equal(replay.response.status, 201);
  assert.equal(first.payload.id, replay.payload.id);
  itemAId = String(first.payload.id);

  const rows = await getDb()
    .select({ id: workItemsTable.id })
    .from(workItemsTable);
  assert.equal(rows.filter((row) => row.id === itemAId).length, 1);

  const commentRequestId = randomUUID();
  const sendComment = () =>
    fetch(`${staffBase}/work-items/${itemAId}/comments`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        clientRequestId: commentRequestId,
        body: "Return reviewed and ready.",
      }),
    });
  const comment = await sendComment();
  const commentReplay = await sendComment();
  assert.equal(comment.status, 201);
  assert.equal(commentReplay.status, 201);
  const commentPayload = (await comment.json()) as { id: string };
  const replayPayload = (await commentReplay.json()) as { id: string };
  assert.equal(commentPayload.id, replayPayload.id);
  commentId = commentPayload.id;
  const comments = await getDb()
    .select({ id: workItemCommentsTable.id })
    .from(workItemCommentsTable)
    .where(eq(workItemCommentsTable.workItemId, itemAId));
  assert.equal(comments.length, 1);
});

test("visible text is required and comments remain append-only", async () => {
  const blankTask = await createWork(staffBase, {
    clientRequestId: randomUUID(),
    clientPartyId: clientAId,
    title: "  ",
  });
  assert.equal(blankTask.response.status, 400);

  const blankComment = await fetch(
    `${staffBase}/work-items/${itemAId}/comments`,
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ clientRequestId: randomUUID(), body: "   " }),
    },
  );
  assert.equal(blankComment.status, 400);

  await assert.rejects(
    getDb()
      .update(workItemCommentsTable)
      .set({ body: "Mutation must be rejected" })
      .where(eq(workItemCommentsTable.id, commentId)),
    (err: unknown) => {
      const cause = (err as { cause?: { message?: string } }).cause;
      assert.match(
        cause?.message ?? (err instanceof Error ? err.message : String(err)),
        /append_only_violation/,
      );
      return true;
    },
  );
});

test("optimistic versions reject stale concurrent updates", async () => {
  const current = (await (
    await fetch(`${staffBase}/work-items`)
  ).json()) as Array<{ id: string; version: number }>;
  const item = current.find((entry) => entry.id === itemAId);
  assert.ok(item);
  const first = await fetch(`${staffBase}/work-items/${itemAId}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({ version: item.version, status: "in_progress" }),
  });
  assert.equal(first.status, 200);
  const stale = await fetch(`${staffBase}/work-items/${itemAId}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({ version: item.version, status: "done" }),
  });
  assert.equal(stale.status, 409);
});

test("client scope hides sibling work and blocks metadata tampering", async () => {
  const created = await createWork(staffBase, {
    clientRequestId: randomUUID(),
    clientPartyId: clientBId,
    title: "Sibling client work",
  });
  assert.equal(created.response.status, 201);
  itemBId = String(created.payload.id);

  const visible = (await (
    await fetch(`${clientBase}/work-items`)
  ).json()) as Array<{ id: string; clientPartyId: string }>;
  assert.ok(visible.some((entry) => entry.id === itemAId));
  assert.ok(visible.every((entry) => entry.clientPartyId === clientAId));
  assert.equal(
    (await fetch(`${clientBase}/work-items/${itemBId}/comments`)).status,
    404,
  );

  const latest = (await (
    await fetch(`${clientBase}/work-items`)
  ).json()) as Array<{ id: string; version: number }>;
  const own = latest.find((entry) => entry.id === itemAId);
  assert.ok(own);
  const tamper = await fetch(`${clientBase}/work-items/${itemAId}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      version: own.version,
      title: "Changed by client",
    }),
  });
  assert.equal(tamper.status, 403);
});

test("client assignments and mentions cannot cross client boundaries", async () => {
  const invalidAssignment = await createWork(clientBase, {
    clientRequestId: randomUUID(),
    title: "Ask accountant a question",
    assignedTo: staffId,
  });
  assert.equal(invalidAssignment.response.status, 403);

  const mention = await fetch(`${clientBase}/work-items/${itemAId}/comments`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      clientRequestId: randomUUID(),
      body: "Please review this note.",
      mentionedUserIds: [clientUserBId],
    }),
  });
  assert.equal(mention.status, 400);
});

test("keyset pages reach all 125 tasks and reject client/filter cursor replay", async () => {
  const due = new Date("2026-10-01T12:00:00.000Z");
  const ids = Array.from({ length: 125 }, () => randomUUID());
  await getDb()
    .insert(workItemsTable)
    .values(
      ids.map((id, index) => ({
        id,
        firmId,
        clientPartyId: clientAId,
        createdBy: staffId,
        clientRequestId: randomUUID(),
        title: `Pagination task ${index}`,
        status: "done" as const,
        priority: index < 30 ? ("urgent" as const) : ("normal" as const),
        dueAt: index % 2 === 0 ? due : null,
      })),
    );
  const seen = new Set<string>();
  let cursor: string | null = null;
  let firstCursor = "";
  do {
    const query = new URLSearchParams({ view: "done", limit: "17" });
    if (cursor) query.set("cursor", cursor);
    const response = await fetch(`${clientBase}/work-items/page?${query}`);
    assert.equal(response.status, 200);
    const page = (await response.json()) as {
      total: number;
      items: Array<{ id: string; clientPartyId: string }>;
      nextCursor: string | null;
    };
    assert.equal(page.total, 125);
    assert.ok(page.items.length <= 17);
    for (const item of page.items) {
      assert.equal(item.clientPartyId, clientAId);
      assert.ok(
        !seen.has(item.id),
        "no duplicate rows at equal due dates or null boundary",
      );
      seen.add(item.id);
    }
    cursor = page.nextCursor;
    firstCursor ||= cursor ?? "";
  } while (cursor);
  assert.deepEqual([...seen].sort(), [...ids].sort());
  assert.equal(
    (
      await fetch(
        `${clientBase}/work-items/page?view=active&cursor=${firstCursor}`,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(
        `${staffBase}/work-items/page?view=done&cursor=${firstCursor}`,
      )
    ).status,
    400,
  );
  assert.equal(
    (await fetch(`${clientBase}/work-items/page?clientPartyId=${clientBId}`))
      .status,
    403,
  );
  assert.equal(
    (await fetch(`${clientBase}/work-items/page?limit=101`)).status,
    400,
  );
});
