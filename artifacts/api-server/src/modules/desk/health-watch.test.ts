import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  getDb,
  featureFlagsTable,
  membershipsTable,
  messagesTable,
  usersTable,
} from "@workspace/db";
import { setFlag } from "../flags/flags.ts";
import {
  setMessageTransport,
  resetMessageTransport,
} from "../messaging/messaging.ts";
import { pointerEntityRef } from "../messaging/recipient-ref.ts";
import {
  sweepHealthWatch,
  RAIL_CIRCUIT_OPEN_ACTION,
  OUTBOX_DEAD_ACTION,
  WEBHOOK_DELIVERY_DEAD_ACTION,
  type HealthWatchDeps,
} from "./health-watch.ts";
import { latestAuditEvent } from "../../test-helpers/audit.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Platform health watch. Pinned invariants:
//  - each degraded unit alerts ONCE via the append-only audit ledger (rails
//    key per outage INSTANCE — rail:openedAt — so a re-open alerts again);
//  - the webhook-delivery alert carries the owning firm in the audit row's
//    firmId field and pointer-only evidence ({webhookId}, never a URL);
//  - NEW alerts are offered to operators over the messaging rail: identity-
//    stamped (recipientUserId), pointer-only refs, flag-gated (a dark
//    messaging_notifications flag means no ledger rows — correct, not a bug);
//  - sends are best-effort: a failing transport never fails the sweep or the
//    durable alert.
// Condition sources are injected (the SpendWatchDeps isolation trick);
// fixtures are salted/random because the ledger and shared DB persist.

const SALT = makeRunSalt();
const FLAG = "messaging_notifications";

const operatorUserId = randomUUID();
const operatorRef = pointerEntityRef("usr", operatorUserId);

// Captures every transport call; individual tests may swap it and put this
// one back.
const sends: { channel: string; recipientRef: string; templateKey: string; entityRef: string | null }[] = [];
const capturingTransport = async (
  channel: string,
  recipientRef: string,
  templateKey: string,
  entityRef: string | null,
) => {
  sends.push({ channel, recipientRef, templateKey, entityRef });
  return { ok: true, providerMessageId: `prov_test_${SALT}` };
};

const quiet: HealthWatchDeps = {
  openRails: async () => [],
  deadOutboxEvents: async () => [],
  deadWebhookDeliveries: async () => [],
};

async function operatorHealthMessages() {
  return getDb()
    .select()
    .from(messagesTable)
    .where(
      and(
        eq(messagesTable.recipientUserId, operatorUserId),
        eq(messagesTable.templateKey, "platform_health"),
      ),
    );
}

// Flag save/restore: these tests flip messaging_notifications, so put it back
// exactly as found (delete when it did not pre-exist).
let flagWasEnabled: boolean | null = null;

before(async () => {
  const db = getDb();
  const [existing] = await db
    .select()
    .from(featureFlagsTable)
    .where(eq(featureFlagsTable.key, FLAG))
    .limit(1);
  flagWasEnabled = existing ? existing.enabled : null;
  // Dark to start: the dedup tests double as the dark-flag ones.
  await db
    .insert(featureFlagsTable)
    .values({ key: FLAG, enabled: false, description: "test" })
    .onConflictDoUpdate({ target: featureFlagsTable.key, set: { enabled: false } });

  await db
    .insert(usersTable)
    .values({ id: operatorUserId, email: `health-${SALT}@test.local` })
    .onConflictDoNothing();
  // Cross-tenant operator membership (firmId null) — the offer rail's
  // recipient enumeration.
  await db.insert(membershipsTable).values({ userId: operatorUserId, role: "operator" });

  setMessageTransport(capturingTransport);
});

after(async () => {
  resetMessageTransport();
  const db = getDb();
  if (flagWasEnabled === null) {
    await db.delete(featureFlagsTable).where(eq(featureFlagsTable.key, FLAG));
  } else {
    await setFlag(FLAG, flagWasEnabled);
  }
});

test("an open rail circuit alerts once per outage instance, not per pass", async () => {
  const rail = `test_rail_${SALT}`;
  const openedAt = new Date("2026-07-20T06:00:00.000Z");
  const deps: HealthWatchDeps = {
    ...quiet,
    openRails: async () => [{ rail, openedAt, failureCount: 3 }],
  };

  const first = await sweepHealthWatch(deps);
  assert.equal(first.openRails, 1);
  assert.equal(first.alerted, 1);
  assert.equal(first.offered, 0, "messaging is dark: no offers, and that is correct");

  const event = await latestAuditEvent(
    RAIL_CIRCUIT_OPEN_ACTION,
    `${rail}:${openedAt.toISOString()}`,
  );
  assert.ok(event, "the outage landed in the audit ledger");
  assert.equal(event.entityType, "rail");
  assert.equal((event.after as { rail?: string }).rail, rail);
  assert.equal((event.after as { failureCount?: number }).failureCount, 3);

  // Same outage instance on the next pass: the ledger dedups.
  const second = await sweepHealthWatch(deps);
  assert.deepEqual(
    { alerted: second.alerted, openRails: second.openRails },
    { alerted: 0, openRails: 1 },
  );

  // The rail recovers and trips AGAIN: a new openedAt is a new outage
  // instance and alerts anew.
  const reopenedAt = new Date("2026-07-21T09:30:00.000Z");
  const third = await sweepHealthWatch({
    ...quiet,
    openRails: async () => [{ rail, openedAt: reopenedAt, failureCount: 4 }],
  });
  assert.equal(third.alerted, 1);
  assert.ok(
    await latestAuditEvent(RAIL_CIRCUIT_OPEN_ACTION, `${rail}:${reopenedAt.toISOString()}`),
  );
});

test("dead outbox events and webhook deliveries alert once each; the webhook alert is firm-stamped and pointer-only", async () => {
  const eventId = randomUUID();
  const deliveryId = randomUUID();
  const firmId = randomUUID();
  const webhookId = randomUUID();
  const deps: HealthWatchDeps = {
    openRails: async () => [],
    deadOutboxEvents: async () => [
      { id: eventId, aggregateType: "invoice", type: "invoice.submitted", attempts: 6 },
    ],
    deadWebhookDeliveries: async () => [
      { id: deliveryId, firmId, webhookId, attempts: 6 },
    ],
  };

  const first = await sweepHealthWatch(deps);
  assert.equal(first.deadOutbox, 1);
  assert.equal(first.deadDeliveries, 1);
  assert.equal(first.alerted, 2);

  const outboxEvent = await latestAuditEvent(OUTBOX_DEAD_ACTION, eventId);
  assert.ok(outboxEvent);
  assert.equal(outboxEvent.entityType, "outbox_event");
  assert.equal((outboxEvent.after as { type?: string }).type, "invoice.submitted");

  const webhookEvent = await latestAuditEvent(WEBHOOK_DELIVERY_DEAD_ACTION, deliveryId);
  assert.ok(webhookEvent);
  assert.equal(webhookEvent.entityType, "webhook_delivery");
  assert.equal(webhookEvent.firmId, firmId, "the audit row names the owning firm");
  // Pointer-only evidence (SEC-12): the webhook id plus the human reason —
  // never the endpoint URL, the event payload or the delivery error.
  assert.deepEqual(
    Object.keys(webhookEvent.after as Record<string, unknown>).sort(),
    ["reason", "webhookId"],
  );
  assert.equal((webhookEvent.after as { webhookId?: string }).webhookId, webhookId);

  const second = await sweepHealthWatch(deps);
  assert.equal(second.alerted, 0, "both units are already alerted");
});

test("a dark messaging flag left no message rows for any of the above", async () => {
  assert.deepEqual(await operatorHealthMessages(), []);
  assert.equal(sends.length, 0, "the transport was never touched");
});

test("a NEW alert is offered to operators: identity-stamped, pointer-only, deduped with the alert", async () => {
  await setFlag(FLAG, true);
  const eventId = randomUUID();
  const deps: HealthWatchDeps = {
    ...quiet,
    deadOutboxEvents: async () => [
      { id: eventId, aggregateType: "invoice", type: "invoice.submitted", attempts: 6 },
    ],
  };

  const result = await sweepHealthWatch(deps);
  assert.equal(result.alerted, 1);
  assert.ok(result.offered >= 1, "at least this file's operator was offered");

  const rows = await operatorHealthMessages();
  assert.equal(rows.length, 1, "one nudge for this operator");
  assert.equal(rows[0].channel, "email");
  assert.equal(rows[0].status, "sent");
  assert.equal(rows[0].recipientRef, operatorRef);
  assert.equal(rows[0].entityType, "health_alert");
  assert.equal(
    rows[0].entityId,
    pointerEntityRef("ops", OUTBOX_DEAD_ACTION),
    "the entity pointer names the alert KIND only",
  );
  // The wire saw pointers only: no address-like or digit-heavy refs.
  assert.ok(sends.length >= 1);
  for (const send of sends) {
    assert.equal(send.templateKey, "platform_health");
    assert.ok(!/@/.test(send.recipientRef));
    assert.ok(send.recipientRef.replace(/\D/g, "").length < 8);
  }

  // Second pass, same dead event: the alert dedups, so nothing is re-offered.
  const again = await sweepHealthWatch(deps);
  assert.deepEqual({ alerted: again.alerted, offered: again.offered }, { alerted: 0, offered: 0 });
  assert.equal((await operatorHealthMessages()).length, 1);
});

test("a throwing transport never fails the sweep; the durable alert stands", async () => {
  setMessageTransport(async () => {
    throw new Error("relay down");
  });
  try {
    const eventId = randomUUID();
    const result = await sweepHealthWatch({
      ...quiet,
      deadOutboxEvents: async () => [
        { id: eventId, aggregateType: "invoice", type: "invoice.submitted", attempts: 6 },
      ],
    });
    assert.equal(result.alerted, 1, "the audit alert appended regardless");
    assert.ok(await latestAuditEvent(OUTBOX_DEAD_ACTION, eventId));
  } finally {
    setMessageTransport(capturingTransport);
  }
});
