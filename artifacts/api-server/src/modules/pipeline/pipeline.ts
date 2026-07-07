import { and, asc, eq, ne, sql } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  outboxTable,
  invoicesTable,
  submissionAttemptsTable,
  stampRecordsTable,
  type OutboxEvent,
} from "@workspace/db";
import { appendAudit } from "../audit/audit";
import { buildCanonical } from "../invoice/service";
import { recordTransition } from "../invoice/lifecycle";
import { submitWithFailover } from "../rails/adapter";
import { isRetriable } from "../errors";

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
    return { kind: "done" };
  }

  if (result.status === "rejected") {
    // Terminal business rejection: mark failed, do not retry.
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
      reason: result.errorCode ?? "rejected",
    });
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
    reason: result.errorCode ?? "error",
  });
  return { kind: "dead", error: result.errorCode ?? "UNKNOWN" };
}

const HANDLERS: Record<
  string,
  (e: OutboxEvent) => Promise<HandlerOutcome>
> = {
  "invoice.submit": handleInvoiceSubmit,
};

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
  return runInBypassContext(async () => {
    const event = await claimnextSafe();
    if (!event) return false;
    const handler = HANDLERS[event.type];
    try {
      const outcome: HandlerOutcome = handler
        ? await handler(event)
        : { kind: "dead", error: `No handler for ${event.type}` };
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
      }
      return true;
    } catch (err) {
      // Unexpected error: re-queue with backoff (or dead-letter past maxAttempts).
      const attempts = event.attempts + 1;
      const dead = attempts >= event.maxAttempts;
      await getDb()
        .update(outboxTable)
        .set({
          status: dead ? "dead" : "pending",
          attempts,
          lockedAt: null,
          lastError: err instanceof Error ? err.message : String(err),
          nextAttemptAt: dead
            ? new Date()
            : new Date(Date.now() + backoffMs(attempts)),
        })
        .where(eq(outboxTable.id, event.id));
      return true;
    }
  });
}

async function claimnextSafe(): Promise<OutboxEvent | null> {
  try {
    return await claimnext();
  } catch {
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

// Reconciliation runs on a slower cadence than the drain loop.
const RECONCILE_INTERVAL_MS = 30_000;

// In-process polling worker (modular monolith). Guarded against double-start.
// A fast loop drains the outbox; a slower loop runs the scheduled
// reconciliation sweeps (stuck-submission re-enqueue + duplicate-stamp
// collapse) so INT-09 recovery does not depend on a manual operator trigger.
export function startWorker(intervalMs = 1_500): void {
  if (timer) return;
  timer = setInterval(() => {
    void drain().catch(() => {});
  }, intervalMs);
  // Do not keep the event loop alive solely for the worker.
  timer.unref?.();

  reconcileTimer = setInterval(() => {
    void reconcile().catch(() => {});
    void reconcileDuplicateStamps().catch(() => {});
  }, RECONCILE_INTERVAL_MS);
  reconcileTimer.unref?.();
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
}
