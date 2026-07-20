import { and, eq } from "drizzle-orm";
import { getDb, auditEventsTable } from "@workspace/db";
import { logger } from "../../lib/logger";
import { appendAudit } from "../audit/audit";

// Shared plumbing for the zero-model-call watch sweeps (spend-watch,
// quality-watch, resistance-watch). Each watch keeps its own detection rule;
// what they share is the boring-but-critical alert discipline: env-tunable
// thresholds that fail safe, a durable once-per-condition alert keyed on the
// append-only audit ledger, and an hourly cadence (they alert on day/month
// buckets — re-running every sweep minute buys nothing).

// A malformed value (empty string → 0, garbage → NaN) must never produce
// NaN comparisons/rates or a permanently-silent watch — fall back to the
// default instead.
export function envThreshold(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// One alert per entity: the append-only audit ledger is the durable
// cross-instance dedup key, fronted by an in-process cache so the long tail
// of a detected condition (a degraded month, a spiked day) doesn't re-query
// the ledger every pass. Two instances FIRST detecting the same condition
// simultaneously can, in the worst case, both append (the audit advisory lock
// serializes the appends, not the check-then-append) — a harmless duplicate
// history row, accepted rather than adding a lock.
//
// Returns a function that appends at most one audit event + error log per
// entityId; the boolean says whether THIS call appended (false = deduped).
// `after` carries the evidence payload (including a human `reason`); the log
// line gets the same fields minus `reason` (the message is the reason there).
export function alertOnceViaAuditLedger(config: {
  action: string;
  entityType: string;
  actorId: string;
}): (
  entityId: string,
  after: Record<string, unknown>,
  logMessage: string,
) => Promise<boolean> {
  const alerted = new Set<string>();
  return async (entityId, after, logMessage) => {
    if (alerted.has(entityId)) return false;

    const [existing] = await getDb()
      .select({ seq: auditEventsTable.seq })
      .from(auditEventsTable)
      .where(
        and(
          eq(auditEventsTable.action, config.action),
          eq(auditEventsTable.entityId, entityId),
        ),
      )
      .limit(1);
    if (existing) {
      alerted.add(entityId);
      return false;
    }

    await appendAudit({
      actorId: config.actorId,
      actorRole: "system",
      action: config.action,
      entityType: config.entityType,
      entityId,
      after,
    });
    const { reason: _reason, ...logFields } = after;
    logger.error(logFields, logMessage);
    alerted.add(entityId);
    return true;
  };
}

// Cadence gate for the watch sweeps: the shared sweep loop ticks every
// minute, but these watches compare day/month buckets — nothing they alert on
// can change observably inside an hour. The module-level timestamp advances
// BEFORE the run, so a failing pass also waits out the hour rather than
// retrying every minute (an hour's detection delay is nothing at day/month
// granularity). Tests call the underlying sweep directly and are unaffected.
export function atMostHourly(
  sweep: () => Promise<unknown>,
  intervalMs = 60 * 60 * 1000,
): () => Promise<unknown> {
  let lastRun = 0;
  return async () => {
    if (Date.now() - lastRun < intervalMs) return;
    lastRun = Date.now();
    return sweep();
  };
}
