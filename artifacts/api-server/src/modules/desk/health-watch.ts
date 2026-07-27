import { and, eq } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  railStatesTable,
  outboxTable,
  firmWebhookDeliveriesTable,
  membershipsTable,
  auditEventsTable,
} from "@workspace/db";
import { logger } from "../../lib/logger";
import { appendAudit } from "../audit/audit";
import { registerSweep } from "../pipeline/pipeline";
import { alertOnceViaAuditLedger, atMostHourly } from "../clerk/watch-shared";
import { isFeatureEnabled } from "../flags/flags";
import { sendMessage } from "../messaging/messaging";
import { pointerEntityRef } from "../messaging/recipient-ref";

// Platform health watch — the ops sibling of the clerk watch trio. Three
// degraded conditions the platform already records but nobody is paged about:
// a rail circuit breaker stuck open, outbox events in the dead-letter queue,
// and firm webhook deliveries that exhausted their retries. Pure rules over
// existing state — zero model calls, no automatic remediation (replay/close
// are operator judgements; the Desk has the buttons). Alert discipline is the
// established one: a durable once-per-unit audit alert (the append-only
// ledger is the cross-instance dedup key) plus an error-level log line, at an
// hourly cadence. NEW alerts are additionally OFFERED to operators over the
// messaging rail — best-effort and flag-gated; the audit alert is the source
// of truth, a lost nudge is never a lost alert.

export const RAIL_CIRCUIT_OPEN_ACTION = "ops.rail.circuit_open";
export const OUTBOX_DEAD_ACTION = "ops.outbox.dead";
export const WEBHOOK_DELIVERY_DEAD_ACTION = "ops.webhook.delivery_dead";

export interface OpenRailRow {
  rail: string;
  openedAt: Date | null;
  failureCount: number;
}

export interface DeadOutboxRow {
  id: string;
  aggregateType: string;
  type: string;
  attempts: number;
}

export interface DeadDeliveryRow {
  id: string;
  firmId: string;
  webhookId: string;
  attempts: number;
}

// The condition sources are injectable so tests exercise the alert/dedup/offer
// logic without depending on whatever rows other suites left in the shared DB
// (the SpendWatchDeps isolation trick).
export interface HealthWatchDeps {
  openRails: () => Promise<OpenRailRow[]>;
  deadOutboxEvents: () => Promise<DeadOutboxRow[]>;
  deadWebhookDeliveries: () => Promise<DeadDeliveryRow[]>;
}

const realDeps: HealthWatchDeps = {
  openRails: async () =>
    getDb()
      .select({
        rail: railStatesTable.rail,
        openedAt: railStatesTable.openedAt,
        failureCount: railStatesTable.failureCount,
      })
      .from(railStatesTable)
      .where(eq(railStatesTable.state, "open")),
  deadOutboxEvents: async () =>
    getDb()
      .select({
        id: outboxTable.id,
        aggregateType: outboxTable.aggregateType,
        type: outboxTable.type,
        attempts: outboxTable.attempts,
      })
      .from(outboxTable)
      .where(eq(outboxTable.status, "dead")),
  deadWebhookDeliveries: async () =>
    getDb()
      .select({
        id: firmWebhookDeliveriesTable.id,
        firmId: firmWebhookDeliveriesTable.firmId,
        webhookId: firmWebhookDeliveriesTable.webhookId,
        attempts: firmWebhookDeliveriesTable.attempts,
      })
      .from(firmWebhookDeliveriesTable)
      .where(eq(firmWebhookDeliveriesTable.status, "dead")),
};

// One alert per OUTAGE INSTANCE, not per sweep pass: the entity key carries
// openedAt, so a rail that recovers and trips again is a new alert while a
// long outage stays one. (openedAt is always stamped when the breaker opens;
// "unknown" is a defensive key for a hand-seeded row, deduped like any other.)
const alertRailOpen = alertOnceViaAuditLedger({
  action: RAIL_CIRCUIT_OPEN_ACTION,
  entityType: "rail",
  actorId: "health-watch",
});

const alertOutboxDead = alertOnceViaAuditLedger({
  action: OUTBOX_DEAD_ACTION,
  entityType: "outbox_event",
  actorId: "health-watch",
});

// The webhook alert must carry the owning firm in the audit row's firmId
// field, which alertOnceViaAuditLedger's config cannot stamp — so this is the
// shared helper's discipline verbatim (in-process cache over the ledger's
// (action, entityId) dedup key; the worst-case simultaneous-first-detection
// duplicate is accepted the same way) with the one added field. The `after`
// evidence is pointer-only (SEC-12): the webhook id, never its URL, the event
// payload or the delivery error text.
const webhookAlerted = new Set<string>();
async function alertWebhookDeadOnce(delivery: DeadDeliveryRow): Promise<boolean> {
  if (webhookAlerted.has(delivery.id)) return false;
  const [existing] = await getDb()
    .select({ seq: auditEventsTable.seq })
    .from(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.action, WEBHOOK_DELIVERY_DEAD_ACTION),
        eq(auditEventsTable.entityId, delivery.id),
      ),
    )
    .limit(1);
  if (existing) {
    webhookAlerted.add(delivery.id);
    return false;
  }
  await appendAudit({
    actorId: "health-watch",
    actorRole: "system",
    firmId: delivery.firmId,
    action: WEBHOOK_DELIVERY_DEAD_ACTION,
    entityType: "webhook_delivery",
    entityId: delivery.id,
    after: {
      webhookId: delivery.webhookId,
      reason:
        "A firm webhook delivery exhausted its retries and went dead: the firm's endpoint never acknowledged the event.",
    },
  });
  logger.error(
    { firmId: delivery.firmId, webhookId: delivery.webhookId },
    "Firm webhook delivery DEAD after max attempts: the firm's endpoint is not accepting events.",
  );
  webhookAlerted.add(delivery.id);
  return true;
}

// Offer NEW alerts to operators over the messaging rail, one pointer-only
// nudge per operator per new alert. Gated on the messaging_notifications flag
// like every send rail (PL-02: dark flag = no ledger rows at all — correct,
// not a failure); recipient identity is the operator's own userId (the column
// the notification inbox reads by — the lossy usr- ref stays display-only),
// and the entity pointer names only the alert KIND (SEC-12: no rail names,
// firm ids or event ids ride the message). Returns sends recorded (a failed
// channel still records a ledger row; only a throw is skipped).
async function offerToOperators(actions: string[]): Promise<number> {
  if (!(await isFeatureEnabled("messaging_notifications", null))) return 0;
  // Operator memberships are cross-tenant (firmId null); distinct so a user
  // holding several operator rows is addressed once per alert.
  const operators = await getDb()
    .selectDistinct({ userId: membershipsTable.userId })
    .from(membershipsTable)
    .where(eq(membershipsTable.role, "operator"));
  let offered = 0;
  for (const action of actions) {
    for (const operator of operators) {
      try {
        await sendMessage({
          channel: "email",
          recipientRef: pointerEntityRef("usr", operator.userId),
          recipientUserId: operator.userId,
          templateKey: "platform_health",
          entityType: "health_alert",
          entityId: pointerEntityRef("ops", action),
        });
        offered += 1;
      } catch {
        // Best-effort by design: the durable audit alert is the source of
        // truth, and one operator's failed send must not starve the rest.
      }
    }
  }
  return offered;
}

export interface HealthWatchResult {
  checked: boolean;
  openRails: number; // conditions currently detected...
  deadOutbox: number;
  deadDeliveries: number;
  alerted: number; // ...vs alerts actually appended (dedup skips the rest)
  offered: number; // operator nudges recorded for the NEW alerts
}

export async function sweepHealthWatch(
  deps: HealthWatchDeps = realDeps,
): Promise<HealthWatchResult> {
  return runInBypassContext(async () => {
    const openRails = await deps.openRails();
    const deadOutbox = await deps.deadOutboxEvents();
    const deadDeliveries = await deps.deadWebhookDeliveries();

    // One entry per alert actually appended this pass; the offer step below
    // nudges once per entry, so a deduped (already-alerted) unit re-sends
    // nothing.
    const newAlerts: string[] = [];

    for (const rail of openRails) {
      const openedAt = rail.openedAt?.toISOString() ?? "unknown";
      const appended = await alertRailOpen(
        `${rail.rail}:${openedAt}`,
        {
          rail: rail.rail,
          openedAt,
          failureCount: rail.failureCount,
          reason:
            "The rail's circuit breaker is open: submissions are failing over or queueing until the rail recovers.",
        },
        "Rail circuit breaker OPEN: submissions to this rail are failing; review rail health on the Compliance Desk.",
      );
      if (appended) newAlerts.push(RAIL_CIRCUIT_OPEN_ACTION);
    }

    for (const event of deadOutbox) {
      const appended = await alertOutboxDead(
        event.id,
        {
          aggregateType: event.aggregateType,
          type: event.type,
          attempts: event.attempts,
          reason:
            "An outbox event exhausted its retries and is dead-lettered: the side effect it carries never ran.",
        },
        "Outbox event DEAD after max attempts: replay it from the operator dead-letter queue.",
      );
      if (appended) newAlerts.push(OUTBOX_DEAD_ACTION);
    }

    for (const delivery of deadDeliveries) {
      if (await alertWebhookDeadOnce(delivery)) {
        newAlerts.push(WEBHOOK_DELIVERY_DEAD_ACTION);
      }
    }

    // Sends run LAST and outside any failure path: nothing after them can
    // roll back the appended alerts, and their own failures are absorbed.
    let offered = 0;
    if (newAlerts.length > 0) {
      try {
        offered = await offerToOperators(newAlerts);
      } catch {
        // The durable audit alerts above already landed.
      }
    }

    return {
      checked: true,
      openRails: openRails.length,
      deadOutbox: deadOutbox.length,
      deadDeliveries: deadDeliveries.length,
      alerted: newAlerts.length,
      offered,
    };
  });
}

registerSweep(atMostHourly(sweepHealthWatch));
