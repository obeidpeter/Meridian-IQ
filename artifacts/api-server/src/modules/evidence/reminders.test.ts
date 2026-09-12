import { before, test } from "node:test";
import assert from "node:assert/strict";
import { and, eq, sql } from "drizzle-orm";
import {
  engagementsTable,
  evidenceEventsTable,
  evidenceRequestsTable,
  featureFlagOverridesTable,
  featureFlagsTable,
  getDb,
  membershipsTable,
  messagesTable,
  runInBypassContext,
} from "@workspace/db";
import { clientPrincipal, firmPrincipal } from "../../test-helpers/principals";
import { notificationFeedFor } from "../messaging/inbox";
import { evidenceFixture } from "./test-fixtures";
import { sweepEvidenceReminders } from "./reminders";

const now = new Date("2099-06-01T23:10:00Z"); // June 2 in Lagos.

before(async () => {
  await getDb()
    .insert(featureFlagsTable)
    .values({ key: "evidence_hub", enabled: false })
    .onConflictDoNothing();
});

async function enabledFixture() {
  const fixture = await evidenceFixture();
  await getDb()
    .insert(featureFlagOverridesTable)
    .values({ flagKey: "evidence_hub", firmId: fixture.firmId, enabled: true });
  return fixture;
}

async function messagesFor(requestId: string) {
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

test("daily reminders are atomic, pointer-only and visible only to the owner and client", async () => {
  const fixture = await enabledFixture();
  const request = await fixture.request({
    dueAt: new Date("2099-06-01T22:59:59Z"),
  });
  const options = { firmId: fixture.firmId };
  assert.equal(await sweepEvidenceReminders(now, options), 1);
  assert.equal(await sweepEvidenceReminders(now, options), 0);
  const messages = await messagesFor(request.id);
  assert.equal(messages.length, 2);
  assert.ok(
    messages.every(
      (message) =>
        message.channel === "in_app" && message.status === "delivered",
    ),
  );
  assert.ok(messages.every((message) => message.providerMessageId === null));
  assert.deepEqual(
    new Set(
      messages.map(
        (message) => message.recipientUserId ?? message.recipientPartyId,
      ),
    ),
    new Set([fixture.ownerId, fixture.clientPartyId]),
  );
  assert.ok(
    messages.every(
      (message) => message.templateKey === "document_request_overdue",
    ),
  );
  assert.ok(!JSON.stringify(messages).includes(request.title));
  assert.ok(!JSON.stringify(messages).includes(request.description!));
  const events = await getDb()
    .select()
    .from(evidenceEventsTable)
    .where(eq(evidenceEventsTable.requestId, request.id));
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "reminder_sent");
  assert.equal(events[0].firmId, fixture.firmId);
  assert.equal(events[0].actorId, null);
  for (const principal of [
    firmPrincipal(fixture.firmId, { userId: fixture.ownerId }),
    clientPrincipal(fixture.firmId, fixture.clientPartyId, {
      userId: fixture.clientUserId,
    }),
  ]) {
    assert.equal(
      (await notificationFeedFor(principal)).items.filter(
        (item) => item.entityId === request.id,
      ).length,
      1,
    );
  }
  for (const principal of [
    firmPrincipal(fixture.otherFirmId, { userId: fixture.foreignUserId }),
    clientPrincipal(fixture.firmId, fixture.siblingPartyId, {
      userId: fixture.siblingUserId,
    }),
  ]) {
    assert.equal(
      (await notificationFeedFor(principal)).items.filter(
        (item) => item.entityId === request.id,
      ).length,
      0,
    );
  }
  const [saved] = await getDb()
    .select()
    .from(evidenceRequestsTable)
    .where(eq(evidenceRequestsTable.id, request.id));
  assert.equal(saved.lastReminderAt?.toISOString(), now.toISOString());
  assert.equal(saved.version, request.version);
  assert.equal(saved.updatedAt.toISOString(), request.updatedAt.toISOString());
});

test("dedupe follows Lagos midnight, and concurrent sweeps cannot duplicate delivery", async () => {
  const fixture = await enabledFixture();
  const request = await fixture.request({
    dueAt: new Date("2099-06-01T21:00:00Z"),
  });
  const options = { firmId: fixture.firmId };
  assert.equal(
    await sweepEvidenceReminders(new Date("2099-06-01T22:59:59Z"), options),
    1,
  );
  const results = await Promise.all([
    sweepEvidenceReminders(now, options),
    sweepEvidenceReminders(now, options),
  ]);
  assert.equal(
    results.reduce((sum, count) => sum + count, 0),
    1,
  );
  assert.equal((await messagesFor(request.id)).length, 4);
  assert.equal(
    await sweepEvidenceReminders(new Date("2099-06-02T22:59:59Z"), options),
    0,
  );
});

test("dark firms, closed requests, absent due dates and future dates consume no reminder slot", async () => {
  const fixture = await enabledFixture();
  const due = new Date("2099-06-01T12:00:00Z");
  const cancelled = await fixture.request({ status: "cancelled", dueAt: due });
  const accepted = await fixture.request({ status: "accepted", dueAt: due });
  const undated = await fixture.request();
  const future = await fixture.request({
    dueAt: new Date("2099-06-02T23:00:00Z"),
  });
  const dark = await fixture.request({ dueAt: due });
  await getDb()
    .update(featureFlagOverridesTable)
    .set({ enabled: false })
    .where(eq(featureFlagOverridesTable.firmId, fixture.firmId));
  assert.equal(
    await sweepEvidenceReminders(now, { firmId: fixture.firmId }),
    0,
  );
  await getDb()
    .update(featureFlagOverridesTable)
    .set({ enabled: true })
    .where(eq(featureFlagOverridesTable.firmId, fixture.firmId));
  assert.equal(
    await sweepEvidenceReminders(now, { firmId: fixture.firmId }),
    1,
  );
  for (const request of [cancelled, accepted, undated, future]) {
    assert.equal((await messagesFor(request.id)).length, 0);
    const [saved] = await getDb()
      .select()
      .from(evidenceRequestsTable)
      .where(eq(evidenceRequestsTable.id, request.id));
    assert.equal(saved.lastReminderAt, null);
  }
  assert.equal((await messagesFor(dark.id)).length, 2);
});

test("reminders stop on archived engagements and missing members, even when another firm still serves the client", async () => {
  const fixture = await enabledFixture();
  const request = await fixture.request({ dueAt: now });
  await getDb()
    .update(engagementsTable)
    .set({ status: "archived" })
    .where(eq(engagementsTable.firmId, fixture.firmId));
  assert.equal(
    await sweepEvidenceReminders(now, { firmId: fixture.firmId }),
    0,
  );
  await getDb()
    .update(engagementsTable)
    .set({ status: "open" })
    .where(eq(engagementsTable.firmId, fixture.firmId));
  await getDb()
    .delete(membershipsTable)
    .where(eq(membershipsTable.firmId, fixture.firmId));
  assert.equal(
    await sweepEvidenceReminders(now, { firmId: fixture.firmId }),
    0,
  );
  assert.equal((await messagesFor(request.id)).length, 0);
});

test("an existing owner still receives a reminder without inventing client recipients", async () => {
  const fixture = await enabledFixture();
  const request = await fixture.request({ dueAt: now });
  await getDb()
    .delete(membershipsTable)
    .where(
      and(
        eq(membershipsTable.firmId, fixture.firmId),
        eq(membershipsTable.clientPartyId, fixture.clientPartyId),
      ),
    );
  assert.equal(
    await sweepEvidenceReminders(now, { firmId: fixture.firmId }),
    1,
  );
  const messages = await messagesFor(request.id);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].recipientUserId, fixture.ownerId);
});

test("a departed owner does not suppress reminders for existing client members", async () => {
  const fixture = await enabledFixture();
  const request = await fixture.request({ dueAt: now });
  await getDb()
    .delete(membershipsTable)
    .where(
      and(
        eq(membershipsTable.firmId, fixture.firmId),
        eq(membershipsTable.userId, fixture.ownerId),
      ),
    );
  assert.equal(
    await sweepEvidenceReminders(now, { firmId: fixture.firmId }),
    1,
  );
  const messages = await messagesFor(request.id);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].recipientPartyId, fixture.clientPartyId);
  assert.equal(messages[0].recipientUserId, null);
});

test("bounded batches advance past claimed rows and obey cancellation and deadline before claiming", async () => {
  const fixture = await enabledFixture();
  const requests = [];
  for (let i = 0; i < 3; i++)
    requests.push(await fixture.request({ dueAt: now }));
  const options = { firmId: fixture.firmId, batchLimit: 2 };
  assert.equal(
    await sweepEvidenceReminders(now, {
      ...options,
      signal: AbortSignal.abort(),
    }),
    0,
  );
  assert.equal(
    await sweepEvidenceReminders(now, { ...options, deadline: Date.now() - 1 }),
    0,
  );
  assert.equal(await sweepEvidenceReminders(now, options), 2);
  assert.equal(await sweepEvidenceReminders(now, options), 1);
  assert.equal(await sweepEvidenceReminders(now, options), 0);
  for (const request of requests)
    assert.equal((await messagesFor(request.id)).length, 2);
});

test("a firm mutation lock defers reminders without consuming their daily slot", async () => {
  const fixture = await enabledFixture();
  const request = await fixture.request({ dueAt: now });
  let release!: () => void;
  let ready!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const acquired = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const holding = runInBypassContext(async () => {
    await getDb().execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`evidence:${fixture.firmId}`}, 0))`,
    );
    ready();
    await released;
  });
  try {
    await Promise.race([acquired, holding]);
    assert.equal(
      await sweepEvidenceReminders(now, { firmId: fixture.firmId }),
      0,
    );
  } finally {
    release();
    await holding;
  }
  assert.equal((await messagesFor(request.id)).length, 0);
  assert.equal(
    await sweepEvidenceReminders(now, { firmId: fixture.firmId }),
    1,
  );
});
