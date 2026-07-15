import { and, asc, eq, lt, ne, sql } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  outboxTable,
  invoicesTable,
  submissionAttemptsTable,
  stampRecordsTable,
  stampVerificationsTable,
  matchProposalsTable,
  type OutboxEvent,
} from "@workspace/db";
import { appendAudit } from "../audit/audit";
import { buildCanonical } from "../invoice/service";
import { canTransition, recordTransition } from "../invoice/lifecycle";
import { submitWithFailover } from "../rails/adapter";
import { openInvoiceCase } from "../desk/cases";
import { isRetriable } from "../errors";
import { logger } from "../../lib/logger";
import {
  sweepRunsTotal,
  sweepErrorsTotal,
  sweepLastSuccess,
  outboxClaimFailuresTotal,
} from "../../lib/metrics";

// Async submission pipeline (INT-09, SME-03 backend). A transactional outbox row
// is written when an invoice is submitted; this worker drains it, calls the rail
// adapter, appends attempt + stamp records, and applies exponential backoff with
// a dead-letter queue after maxAttempts. Nothing here is synchronous with the
// user request.

const BASE_BACKOFF_MS = 2_000;

function backoffMs(attempts: number): number {
  return BASE_BACKOFF_MS * Math.pow(2, attempts);
}

// A handler reports its result rather than throwing, so the outbox status update
// and the domain writes (attempt/stamp/status/lifecycle) commit atomically in the
// single bypass transaction opened by processOne. `retry` re-queues with backoff;
// `dead` dead-letters immediately (terminal business rejection or non-retriable).
type HandlerOutcome =
  | { kind: "done" }
  | { kind: "retry"; error: string }
  | { kind: "dead"; error: string };

// Shared mark-failed transition for handleInvoiceSubmit's two terminal paths
// (business rejection and non-retriable transport error): flip the invoice to
// `failed` and record the lifecycle transition. The transition reason and any
// per-branch audit stay with the caller.
async function markInvoiceFailed(
  invoiceId: string,
  invoice: { firmId: string; status: (typeof invoicesTable.$inferSelect)["status"] },
  reason: string,
): Promise<void> {
  await getDb()
    .update(invoicesTable)
    .set({ status: "failed" })
    .where(eq(invoicesTable.id, invoiceId));
  await recordTransition({
    invoiceId,
    firmId: invoice.firmId,
    fromStatus: invoice.status,
    toStatus: "failed",
    actorRole: "system",
    reason,
  });
}

async function handleInvoiceSubmit(
  event: OutboxEvent,
): Promise<HandlerOutcome> {
  const invoiceId = String(
    (event.payload as { invoiceId?: string }).invoiceId ?? "",
  );
  const [invoice] = await getDb()
    .select()
    .from(invoicesTable)
    .where(eq(invoicesTable.id, invoiceId))
    .limit(1);
  if (!invoice) return { kind: "dead", error: `Invoice ${invoiceId} missing` };

  const canonical = await buildCanonical(invoiceId);
  const idempotencyKey = `${invoiceId}:${invoice.invoiceNumber}`;
  const attemptNo = event.attempts + 1;
  const { result } = await submitWithFailover(canonical, idempotencyKey);

  await getDb().insert(submissionAttemptsTable).values({
    invoiceId,
    rail: result.rail,
    attemptNo,
    idempotencyKey,
    status:
      result.status === "accepted"
        ? "accepted"
        : result.status === "rejected"
          ? "rejected"
          : "error",
    requestPayload: { invoiceNumber: invoice.invoiceNumber },
    responsePayload: result.raw,
    errorCode: result.errorCode ?? null,
  });

  if (result.status === "accepted") {
    // Idempotent stamp write (INT-09): the unique(invoiceId) constraint plus
    // onConflictDoNothing guarantees a retried/double-processed event can never
    // create a second stamp, without deleting an append-only lifecycle record.
    await getDb()
      .insert(stampRecordsTable)
      .values({
        invoiceId,
        irn: result.irn!,
        csid: result.csid!,
        qrPayload: result.qrPayload!,
        signedArtifactRef: result.signedArtifactRef!,
        rail: result.rail,
      })
      .onConflictDoNothing({ target: stampRecordsTable.invoiceId });
    await getDb()
      .update(invoicesTable)
      .set({ status: "stamped" })
      .where(eq(invoicesTable.id, invoiceId));
    await recordTransition({
      invoiceId,
      firmId: invoice.firmId,
      fromStatus: invoice.status,
      toStatus: "stamped",
      actorRole: "system",
      reason: `rail:${result.rail}`,
    });
    await appendAudit({
      firmId: invoice.firmId,
      action: "invoice.stamped",
      entityType: "invoice",
      entityId: invoiceId,
      after: { irn: result.irn, rail: result.rail },
    });
    // CORE-09: a stamped credit note / correction credits its original in the
    // same transaction, and downstream projections (reconciliation proposals,
    // stamp-verification cache, exposure) react via the lifecycle-changed event.
    if (
      (invoice.kind === "credit_note" || invoice.kind === "correction") &&
      invoice.relatedInvoiceId
    ) {
      await creditOriginal(invoice.relatedInvoiceId, invoiceId);
    }
    return { kind: "done" };
  }

  if (result.status === "rejected") {
    // Terminal business rejection: mark failed, do not retry.
    await markInvoiceFailed(invoiceId, invoice, result.errorCode ?? "rejected");
    await appendAudit({
      firmId: invoice.firmId,
      action: "invoice.rejected",
      entityType: "invoice",
      entityId: invoiceId,
      after: { errorCode: result.errorCode },
    });
    return { kind: "dead", error: result.errorCode ?? "UNKNOWN" };
  }

  // Transient error: re-queue so the outbox backoff logic runs.
  if (isRetriable(result.errorCode ?? "UNKNOWN")) {
    return { kind: "retry", error: result.errorCode ?? "RAIL_ERROR" };
  }
  // Non-retriable transport error: fail terminally.
  await markInvoiceFailed(invoiceId, invoice, result.errorCode ?? "error");
  return { kind: "dead", error: result.errorCode ?? "UNKNOWN" };
}

// CORE-09: transition a credited original when its credit note / correction is
// stamped. Runs inside the worker's bypass transaction so the credit-note stamp
// and the original's transition commit atomically. Idempotent: an original that
// already left the creditable set is recorded, never re-credited.
async function creditOriginal(
  originalId: string,
  adjustmentId: string,
): Promise<void> {
  const [original] = await getDb()
    .select()
    .from(invoicesTable)
    .where(eq(invoicesTable.id, originalId))
    .limit(1);
  if (!original) return;
  if (!canTransition(original.status, "credited")) {
    // Already terminal (e.g. double-processing) — leave an audit trace only.
    await appendAudit({
      firmId: original.firmId,
      action: "invoice.credit_skipped",
      entityType: "invoice",
      entityId: originalId,
      after: { adjustmentId, status: original.status },
    });
    return;
  }
  // Compare-and-set: a concurrent cancel between the read and this write must
  // not be overwritten (CORE-09: terminal states never resurrect).
  const [moved] = await getDb()
    .update(invoicesTable)
    .set({ status: "credited" })
    .where(
      and(
        eq(invoicesTable.id, originalId),
        eq(invoicesTable.status, original.status),
      ),
    )
    .returning({ id: invoicesTable.id });
  if (!moved) {
    await appendAudit({
      firmId: original.firmId,
      action: "invoice.credit_skipped",
      entityType: "invoice",
      entityId: originalId,
      after: { adjustmentId, reason: "concurrent transition" },
    });
    return;
  }
  await recordTransition({
    invoiceId: originalId,
    firmId: original.firmId,
    fromStatus: original.status,
    toStatus: "credited",
    actorRole: "system",
    reason: `credit_note:${adjustmentId}`,
  });
  await appendAudit({
    firmId: original.firmId,
    action: "invoice.credited",
    entityType: "invoice",
    entityId: originalId,
    after: { adjustmentId },
  });
  await getDb().insert(outboxTable).values({
    aggregateType: "invoice",
    aggregateId: originalId,
    type: "invoice.lifecycle_changed",
    payload: { invoiceId: originalId, toStatus: "credited" },
  });
}

// CORE-09 propagation: when an invoice leaves the eligible set (cancelled or
// credited), downstream projections must react — open reconciliation proposals
// are superseded so an accepted match can never settle a dead invoice, and the
// stamp-verification freshness cache is staled so `verify-stamp` re-reads the
// lifecycle immediately rather than serving a cached "eligible".
async function handleLifecycleChanged(
  event: OutboxEvent,
): Promise<HandlerOutcome> {
  const invoiceId = String(
    (event.payload as { invoiceId?: string }).invoiceId ?? "",
  );
  if (!invoiceId) return { kind: "dead", error: "Missing invoiceId" };

  await getDb()
    .update(matchProposalsTable)
    .set({ status: "superseded" })
    .where(
      and(
        eq(matchProposalsTable.invoiceId, invoiceId),
        eq(matchProposalsTable.status, "proposed"),
      ),
    );

  const [stamp] = await getDb()
    .select({ irn: stampRecordsTable.irn, csid: stampRecordsTable.csid })
    .from(stampRecordsTable)
    .where(eq(stampRecordsTable.invoiceId, invoiceId))
    .limit(1);
  if (stamp) {
    await getDb()
      .update(stampVerificationsTable)
      .set({ freshUntil: new Date() })
      .where(
        and(
          eq(stampVerificationsTable.irn, stamp.irn),
          eq(stampVerificationsTable.csid, stamp.csid),
        ),
      );
  }
  return { kind: "done" };
}

const HANDLERS: Record<
  string,
  (e: OutboxEvent) => Promise<HandlerOutcome>
> = {
  "invoice.submit": handleInvoiceSubmit,
  "invoice.lifecycle_changed": handleLifecycleChanged,
};

// Later modules (reconciliation, B2C, connectors) contribute their own outbox
// handlers without touching the worker core.
export function registerHandler(
  type: string,
  handler: (e: OutboxEvent) => Promise<HandlerOutcome>,
): void {
  HANDLERS[type] = handler;
}

export type { HandlerOutcome };

// Claim one pending event atomically (SKIP LOCKED so multiple workers are safe).
async function claimnext(): Promise<OutboxEvent | null> {
  const rows = await getDb().execute<OutboxEvent>(sql`
    UPDATE outbox_events SET status = 'processing', locked_at = now()
    WHERE id = (
      SELECT id FROM outbox_events
      WHERE status = 'pending' AND next_attempt_at <= now()
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING *
  `);
  const list = (rows as unknown as { rows?: OutboxEvent[] }).rows ?? (rows as unknown as OutboxEvent[]);
  return list[0] ?? null;
}

export async function processOne(): Promise<boolean> {
  // The whole claim -> handle -> outbox-status-update runs in one bypass
  // transaction (CON-01/SEC-02): the worker has no request principal, so it must
  // bypass tenant RLS, and a single transaction makes each event's domain writes
  // and its outbox bookkeeping atomic. A thrown error rolls the claim back so the
  // event returns to `pending` and is retried, never left stuck in `processing`.
  // An UNEXPECTED handler throw must not commit the handler's partial domain
  // writes (CON-03). The old code caught the throw and re-queued in the SAME
  // transaction, so a deadlock after a stamp/status write already succeeded
  // committed those writes and the retry appended duplicate immutable lifecycle
  // and audit rows. Handlers signal expected failures by RETURNING a retry/dead
  // outcome (those commit their bookkeeping normally); anything that THROWS
  // propagates out of the transaction so it rolls back — discarding both the
  // partial writes and the `processing` claim (the event returns to `pending`).
  // The failed attempt is then recorded in a SEPARATE transaction so the retry
  // stays bounded and backed-off without re-running the handler.
  let claimedEvent: OutboxEvent | null = null;
  let handlerError: string | null = null;
  try {
    return await runInBypassContext(async () => {
      const event = await claimnextSafe();
      if (!event) return false;
      claimedEvent = event;
      const handler = HANDLERS[event.type];
      let outcome: HandlerOutcome;
      try {
        outcome = handler
          ? await handler(event)
          : { kind: "dead", error: `No handler for ${event.type}` };
      } catch (err) {
        handlerError = err instanceof Error ? err.message : String(err);
        throw err; // roll back partial domain writes + the claim
      }
      const attempts = event.attempts + 1;
      if (outcome.kind === "done") {
        await getDb()
          .update(outboxTable)
          .set({ status: "done", attempts, lockedAt: null })
          .where(eq(outboxTable.id, event.id));
      } else if (outcome.kind === "dead") {
        await getDb()
          .update(outboxTable)
          .set({
            status: "dead",
            attempts,
            lockedAt: null,
            lastError: outcome.error,
            nextAttemptAt: new Date(),
          })
          .where(eq(outboxTable.id, event.id));
        await openCaseForDeadEvent(event, outcome.error);
      } else {
        const dead = attempts >= event.maxAttempts;
        await getDb()
          .update(outboxTable)
          .set({
            status: dead ? "dead" : "pending",
            attempts,
            lockedAt: null,
            lastError: outcome.error,
            nextAttemptAt: dead
              ? new Date()
              : new Date(Date.now() + backoffMs(attempts)),
          })
          .where(eq(outboxTable.id, event.id));
        if (dead) await openCaseForDeadEvent(event, outcome.error);
      }
      return true;
    });
  } catch (err) {
    // Distinguish a handler throw (which we rolled back on purpose) from an
    // infrastructure/claim error unrelated to a handler.
    if (claimedEvent === null || handlerError === null) throw err;
    const event: OutboxEvent = claimedEvent;
    const message: string = handlerError;
    // Fresh transaction: the domain writes and the claim were rolled back, so
    // record only the failed attempt + backoff (or dead-letter). No handler
    // runs here, so no partial ledger rows can be written.
    await runInBypassContext(async () => {
      const attempts = event.attempts + 1;
      const dead = attempts >= event.maxAttempts;
      await getDb()
        .update(outboxTable)
        .set({
          status: dead ? "dead" : "pending",
          attempts,
          lockedAt: null,
          lastError: message,
          nextAttemptAt: dead
            ? new Date()
            : new Date(Date.now() + backoffMs(attempts)),
        })
        .where(eq(outboxTable.id, event.id));
      if (dead) await openCaseForDeadEvent(event, message);
    });
    return true;
  }
}

// SME-06/CON-04: a dead-lettered invoice event is by definition an unresolved
// failure, so it enters the Compliance Desk queue the moment the pipeline
// gives up. Non-invoice aggregates stay visible via the dead-letter list.
async function openCaseForDeadEvent(
  event: OutboxEvent,
  error: string,
): Promise<void> {
  if (event.aggregateType !== "invoice") return;
  try {
    await openInvoiceCase({
      invoiceId: event.aggregateId,
      title: (invoiceNumber) =>
        event.type === "invoice.submit"
          ? `${invoiceNumber} failed: ${error}`
          : `${invoiceNumber} stuck in ${event.type}`,
      errorCode: error,
      priority: "high",
    });
  } catch {
    // Case intake must never fail the outbox bookkeeping it follows.
  }
}

// A claim failure must never kill the drain loop, but it must not be silent
// either: a persistent one (permissions regression, schema drift) would
// otherwise make the pipeline process nothing while every dashboard stays
// green. Log it and count it so the condition is scrapeable.
async function claimnextSafe(): Promise<OutboxEvent | null> {
  try {
    return await claimnext();
  } catch (err) {
    outboxClaimFailuresTotal.inc();
    logger.error({ err }, "outbox claim failed");
    return null;
  }
}

// Drain until no more ready events (bounded to avoid a hot loop).
export async function drain(max = 50): Promise<number> {
  let processed = 0;
  for (let i = 0; i < max; i++) {
    const did = await processOne();
    if (!did) break;
    processed++;
  }
  return processed;
}

// Reconciliation (INT-09): re-enqueue invoices stuck in `submitted` with no
// stamp and no live outbox row (e.g. a crash mid-flight).
export async function reconcile(): Promise<number> {
  return runInBypassContext(async () => {
    const stuck = await getDb()
      .select({ id: invoicesTable.id })
      .from(invoicesTable)
      .where(eq(invoicesTable.status, "submitted"));
    let requeued = 0;
    for (const row of stuck) {
      const [stamp] = await getDb()
        .select({ id: stampRecordsTable.id })
        .from(stampRecordsTable)
        .where(eq(stampRecordsTable.invoiceId, row.id))
        .limit(1);
      if (stamp) continue;
      const [live] = await getDb()
        .select({ id: outboxTable.id })
        .from(outboxTable)
        .where(
          and(
            eq(outboxTable.aggregateId, row.id),
            ne(outboxTable.status, "done"),
            ne(outboxTable.status, "dead"),
          ),
        )
        .limit(1);
      if (live) continue;
      await getDb().insert(outboxTable).values({
        aggregateType: "invoice",
        aggregateId: row.id,
        type: "invoice.submit",
        payload: { invoiceId: row.id },
      });
      requeued++;
    }
    return requeued;
  });
}

// Duplicate-stamp reconciliation (INT-09), append-only (CORE-02). Duplicates are
// prevented at write by the unique(invoiceId) constraint + idempotent insert, so
// this sweep is a defensive detector for any historical/anomalous duplicate. It
// NEVER deletes a stamp: stamps are immutable post-submission. Instead it names
// the canonical (earliest) stamp and records the superseded ones in an audit
// event, so every reader resolves deterministically to the same canonical stamp.
export async function reconcileDuplicateStamps(): Promise<number> {
  return runInBypassContext(async () => {
    const dupes = await getDb().execute<{ invoice_id: string }>(sql`
      SELECT invoice_id FROM stamp_records
      GROUP BY invoice_id HAVING count(*) > 1
    `);
    const list =
      (dupes as unknown as { rows?: { invoice_id: string }[] }).rows ??
      (dupes as unknown as { invoice_id: string }[]);
    let flagged = 0;
    for (const { invoice_id: invoiceId } of list) {
      const stamps = await getDb()
        .select()
        .from(stampRecordsTable)
        .where(eq(stampRecordsTable.invoiceId, invoiceId))
        .orderBy(asc(stampRecordsTable.createdAt));
      const [canonical, ...superseded] = stamps;
      if (!canonical || superseded.length === 0) continue;
      await appendAudit({
        action: "invoice.stamp_duplicate_detected",
        entityType: "invoice",
        entityId: invoiceId,
        after: {
          canonicalStampId: canonical.id,
          supersededStampIds: superseded.map((s) => s.id),
        },
      });
      flagged += superseded.length;
    }
    return flagged;
  });
}

// Replay a dead-lettered event (operator action).
export async function replayDead(outboxId: string): Promise<void> {
  await runInBypassContext(async () => {
    await getDb()
      .update(outboxTable)
      .set({ status: "pending", attempts: 0, nextAttemptAt: new Date(), lastError: null })
      .where(and(eq(outboxTable.id, outboxId), eq(outboxTable.status, "dead")));
  });
}

export async function listDeadLetters(): Promise<OutboxEvent[]> {
  return runInBypassContext(() =>
    getDb()
      .select()
      .from(outboxTable)
      .where(eq(outboxTable.status, "dead"))
      .orderBy(asc(outboxTable.createdAt)),
  );
}

let timer: NodeJS.Timeout | null = null;
let reconcileTimer: NodeJS.Timeout | null = null;
let sweepTimer: NodeJS.Timeout | null = null;

// Reconciliation runs on a slower cadence than the drain loop.
const RECONCILE_INTERVAL_MS = 30_000;
// R2 compliance sweeps: B2C clocks are minute-sensitive (SME-08 pre-breach
// alerts must land >= 4h before the deadline), so the sweep runs every minute;
// buyer exposure snapshots refresh inside the same pass but self-limit to a
// 24-hour window (BR-01), so the frequent cadence costs nothing.
const SWEEP_INTERVAL_MS = 60_000;

// Registered by R2 modules at import time (b2c, buyer) so the worker core does
// not import feature modules.
const SWEEPS: (() => Promise<unknown>)[] = [];
export function registerSweep(sweep: () => Promise<unknown>): void {
  SWEEPS.push(sweep);
}

// Retention for the pipeline's own tables (this module already owns both).
//
// Outbox: a `done` row is pure history once processed — the audit ledger and
// submission_attempts carry the durable trail — but the drain poll's partial
// index only excludes them from the QUEUE scan; the table itself would still
// grow one row per submitted invoice forever. Keep 30 days for debugging,
// then delete. `dead` rows are deliberately kept: they ARE the dead-letter
// queue the operator replays.
//
// Stamp verifications: the public /verify-stamp endpoint inserts a cache row
// per (irn, csid) miss — including garbage pairs from unauthenticated
// traffic — and a fresh row per TTL expiry. Rows stale for 30 days can never
// serve a cache hit again; delete them.
const PIPELINE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export async function sweepPipelineRetention(): Promise<void> {
  await runInBypassContext(async () => {
    const cutoff = new Date(Date.now() - PIPELINE_RETENTION_MS);
    await getDb()
      .delete(outboxTable)
      .where(
        and(eq(outboxTable.status, "done"), lt(outboxTable.updatedAt, cutoff)),
      );
    await getDb()
      .delete(stampVerificationsTable)
      .where(lt(stampVerificationsTable.freshUntil, cutoff));
  });
}

registerSweep(sweepPipelineRetention);

// Module-level reentrancy guards shared by the interval loops AND the external
// wake-up trigger (see runScheduledWorkOnce): a run that exceeds its period —
// or an external trigger landing mid-pass — must skip, not overlap, or the
// sweep/reconcile duplication races return (CON-M3).
let draining = false;
let reconciling = false;
let sweeping = false;

// The guarded pass bodies shared by the interval loops (startWorker) and the
// external wake-up trigger (runScheduledWorkOnce). Each skips — never overlaps
// — when its prior run is still in flight, isolates its own errors (logged,
// not silently swallowed), and reports whether it actually ran.

async function guardedSweepPass(): Promise<boolean> {
  if (sweeping) return false;
  sweeping = true;
  try {
    await runSweepPass();
    return true;
  } finally {
    sweeping = false;
  }
}

async function guardedDrainPass(): Promise<{ ran: boolean; drained: number }> {
  if (draining) return { ran: false, drained: 0 };
  draining = true;
  try {
    const drained = await drain();
    return { ran: true, drained };
  } catch (err) {
    logger.error({ err }, "outbox drain failed");
    return { ran: false, drained: 0 };
  } finally {
    draining = false;
  }
}

async function guardedReconcilePass(): Promise<boolean> {
  if (reconciling) return false;
  reconciling = true;
  try {
    await reconcile();
    await reconcileDuplicateStamps();
    return true;
  } catch (err) {
    logger.error({ err }, "pipeline reconcile sweep failed");
    return false;
  } finally {
    reconciling = false;
  }
}

// One full pass of everything the in-process timers would run: outbox drain,
// reconciliation sweeps, and the registered R2 compliance sweeps (pre-breach
// alerts). Used by the public wake-up endpoint so an Autoscale deployment —
// which scales to zero and freezes these timers while idle — still runs the
// time-sensitive work whenever an external scheduler pings it. Everything is
// awaited INSIDE the request so the work finishes before the instance can be
// suspended again. Idempotent by construction: the sweeps guard with
// preBreachAlertAt / batch status, the drain claims with SKIP LOCKED, and the
// shared guards make a concurrent trigger a cheap no-op.
export async function runScheduledWorkOnce(): Promise<{
  ran: { drain: boolean; reconcile: boolean; sweeps: boolean };
  drained: number;
}> {
  const sweeps = await guardedSweepPass();
  const { ran: drainRan, drained } = await guardedDrainPass();
  const reconcileRan = await guardedReconcilePass();
  return {
    ran: { drain: drainRan, reconcile: reconcileRan, sweeps },
    drained,
  };
}

// Run sweeps sequentially so one guard covers the whole pass and they don't
// contend for pool connections; a failing sweep is logged, not silently
// dropped, and does not abort its siblings.
async function runSweepPass(): Promise<void> {
  let failures = 0;
  for (const sweep of SWEEPS) {
    try {
      await sweep();
    } catch (err) {
      failures += 1;
      sweepErrorsTotal.inc();
      logger.error({ err }, "compliance sweep failed");
    }
  }
  // Record pass health for scraping: the run counter advances every pass (the
  // loop-liveness signal — a stalled minute loop, e.g. an Autoscale instance
  // frozen overnight, stops it — OBS-01), while last_success only advances
  // when every sweep in the pass succeeded, so a pass that runs but fails is
  // an alertable condition rather than a green gauge.
  sweepRunsTotal.inc();
  if (failures === 0) sweepLastSuccess.setToCurrentTime();
}

// In-process polling worker (modular monolith). Guarded against double-start.
// A fast loop drains the outbox; a slower loop runs the scheduled
// reconciliation sweeps (stuck-submission re-enqueue + duplicate-stamp
// collapse) so INT-09 recovery does not depend on a manual operator trigger;
// a third loop runs the registered R2 compliance sweeps.
export function startWorker(intervalMs = 1_500): void {
  if (timer) return;

  // Reentrancy guards are module-level (shared with runScheduledWorkOnce):
  // each interval fires on a fixed clock regardless of whether the previous
  // run finished. Without a guard, a run that exceeds its period overlaps the
  // next tick and double-processes (which drives the sweep/reconcile
  // duplication races). The guarded*Pass helpers skip a tick while its prior
  // run is still in flight, and log — rather than silently swallow — errors so
  // a persistently failing loop is visible.

  timer = setInterval(() => {
    void guardedDrainPass();
  }, intervalMs);
  // Do not keep the event loop alive solely for the worker.
  timer.unref?.();

  reconcileTimer = setInterval(() => {
    void guardedReconcilePass();
  }, RECONCILE_INTERVAL_MS);
  reconcileTimer.unref?.();

  sweepTimer = setInterval(() => {
    void guardedSweepPass();
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

export function stopWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
