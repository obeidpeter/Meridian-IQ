import {
  and,
  asc,
  eq,
  gt,
  isNotNull,
  lt,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { randomUUID } from "node:crypto";
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
import {
  railOpenCooldownMs,
  recoverExistingStamp,
  submitWithFailover,
  type FailoverResult,
  type StampResult,
} from "../rails/adapter";
import { RailLookupError } from "../rails/faults";
import { railTimeoutMs } from "../rails/transports/http";
import { openInvoiceCase } from "../desk/cases";
import { DomainError, isRetriable } from "../errors";
import { logger } from "../../lib/logger";
import {
  sweepErrorsTotal,
  outboxClaimFailuresTotal,
  outboxEvents,
  outboxOldestPendingAgeSeconds,
} from "../../lib/metrics";
import {
  registerSweep,
  runRegisteredSweeps,
  settleOwnedWork,
  stopSweeps,
  resumeSweeps,
  type SweepFailureReport,
} from "./sweeps";
import { track } from "./in-flight";
import { withDistributedLock } from "./distributed-lock";

// R107: the sweep registry, per-sweep timeout, settle ceiling and pass runner
// live in ./sweeps and the in-flight tracker in ./in-flight; their public
// names are re-exported here so every existing importer keeps working.
export {
  registerSweep,
  unregisterSweep,
  listSweeps,
  orderedSweeps,
  runSweepsOnce,
  defaultSweepTimeoutMs,
  sweepSettleCeilingMs,
  SWEEP_PASS_ABANDONED_ACTION,
  SweepTimeoutError,
  type RegisteredSweep,
  type SweepFailureReport,
} from "./sweeps";
export { awaitWorkerIdle, inFlightPasses } from "./in-flight";

// Async submission pipeline (INT-09, SME-03 backend). A transactional outbox row
// is written when an invoice is submitted; this worker drains it, calls the rail
// adapter, appends attempt + stamp records, and applies exponential backoff with
// a dead-letter queue after maxAttempts. Nothing here is synchronous with the
// user request.

// Outage policy (R96). A retriable failure is retried on a capped, jittered
// exponential backoff for as long as a WALL-CLOCK horizon allows — measured
// from the event's first attempt, so a 24-hour rail outage is survived
// rather than dead-lettered after the six tries the old attempt count
// allowed (about two minutes). `maxAttempts` remains the minimum number of
// tries an event gets even when its horizon was spent parked. Jitter keeps
// a backlog that wakes together from hitting the rail in one wave.
const BASE_BACKOFF_MS = 2_000;
const DEFAULT_MAX_BACKOFF_MS = 15 * 60 * 1000;
const DEFAULT_RETRY_HORIZON_MS = 24 * 60 * 60 * 1000;
const PARK_JITTER_MS = 2_000;

export function outboxMaxBackoffMs(): number {
  const configured = Number(process.env.OUTBOX_MAX_BACKOFF_MS);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_MAX_BACKOFF_MS;
}

export function outboxRetryHorizonMs(): number {
  const configured = Number(process.env.OUTBOX_RETRY_HORIZON_MS);
  return Number.isFinite(configured) && configured >= 0
    ? Math.floor(configured)
    : DEFAULT_RETRY_HORIZON_MS;
}

/** Capped exponential backoff with half-range jitter: [cap/2, cap] of 2s·2^n. */
export function backoffMs(attempts: number): number {
  const raw = Math.min(
    outboxMaxBackoffMs(),
    BASE_BACKOFF_MS * Math.pow(2, attempts),
  );
  return Math.floor(raw / 2 + Math.random() * (raw / 2));
}

/**
 * Where a failed attempt leaves the event: dead once BOTH the minimum tries
 * and the wall-clock horizon (from the first attempt) are spent, otherwise
 * pending again after the jittered backoff.
 */
export function retryDisposition(
  event: Pick<OutboxEvent, "maxAttempts" | "firstAttemptAt">,
  attempts: number,
  now = new Date(),
  notBefore?: Date | null,
): { dead: boolean; nextAttemptAt: Date; firstAttemptAt: Date } {
  const firstAttemptAt = event.firstAttemptAt ?? now;
  const elapsed = now.getTime() - firstAttemptAt.getTime();
  const dead =
    attempts >= event.maxAttempts && elapsed >= outboxRetryHorizonMs();
  const backoffAt = new Date(now.getTime() + backoffMs(attempts));
  // A rail's Retry-After (R95) is a FLOOR under the backoff, never a ceiling.
  const retryAt =
    notBefore && notBefore.getTime() > backoffAt.getTime()
      ? notBefore
      : backoffAt;
  return {
    dead,
    firstAttemptAt,
    nextAttemptAt: dead ? now : retryAt,
  };
}

// A handler reports its result rather than throwing, so the outbox status update
// and the domain writes (attempt/stamp/status/lifecycle) commit atomically in the
// single bypass transaction opened by processOne. `retry` re-queues with backoff;
// `dead` dead-letters immediately (terminal business rejection or non-retriable);
// `park` (R96) holds the event until the rail's breaker allows a probe — no
// attempt is burned, because nothing was sent.
type HandlerOutcome =
  | { kind: "done" }
  | { kind: "retry"; error: string; notBefore?: Date }
  | { kind: "dead"; error: string }
  | { kind: "park"; until: Date; error: string };

// Shared mark-failed transition for handleInvoiceSubmit's two terminal paths
// (business rejection and non-retriable transport error): flip the invoice to
// `failed` and record the lifecycle transition. The transition reason and any
// per-branch audit stay with the caller.
async function markInvoiceFailed(
  invoiceId: string,
  invoice: {
    firmId: string;
    status: (typeof invoicesTable.$inferSelect)["status"];
  },
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

type InvoiceRow = typeof invoicesTable.$inferSelect;

// A 429's Retry-After (R95): honoured as a floor under the R96 backoff and
// capped, so a mistaken or hostile header cannot park an invoice for a day.
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

function retryAfterFrom(result: StampResult): Date | undefined {
  const ms = Number(
    (result.raw as { retryAfterMs?: unknown } | undefined)?.retryAfterMs,
  );
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return new Date(Date.now() + Math.min(ms, MAX_RETRY_AFTER_MS));
}

/**
 * Persist an accepted stamp and move the invoice to `stamped` (R97 factored
 * this out of the submit handler so duplicate recovery and reconcile share
 * one write path). Idempotent stamp write (INT-09): the unique(invoiceId)
 * constraint plus onConflictDoNothing guarantees a retried/double-processed
 * event can never create a second stamp, without deleting an append-only
 * lifecycle record. `recovered` marks a stamp the rail had already issued and
 * we only fetched back, which the audit trail records as its own action.
 */
async function persistStamp(
  invoice: InvoiceRow,
  result: StampResult,
  recovered: boolean,
): Promise<void> {
  const invoiceId = invoice.id;
  await getDb()
    .insert(stampRecordsTable)
    .values({
      invoiceId,
      irn: result.irn!,
      csid: result.csid!,
      qrPayload: result.qrPayload!,
      signedArtifactRef: result.signedArtifactRef!,
      rail: result.rail,
      provider: result.provider ?? "simulator",
      environment: result.environment ?? "sandbox",
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
    reason: recovered ? `rail:${result.rail}:recovered` : `rail:${result.rail}`,
  });
  await appendAudit({
    firmId: invoice.firmId,
    action: recovered ? "invoice.stamp_recovered" : "invoice.stamped",
    entityType: "invoice",
    entityId: invoiceId,
    after: {
      irn: result.irn,
      rail: result.rail,
      provider: result.provider ?? "simulator",
      environment: result.environment ?? "sandbox",
    },
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
}

interface PreparedInvoiceSubmit {
  invoice: InvoiceRow;
  canonical: Awaited<ReturnType<typeof buildCanonical>>;
  idempotencyKey: string;
  attemptNo: number;
}

interface InvoiceRailEffect {
  failover: FailoverResult;
  recovered: StampResult | null;
  recoveryError: string | null;
}

async function prepareInvoiceSubmit(
  event: OutboxEvent,
): Promise<PreparedInvoiceSubmit | null> {
  const invoiceId = String(
    (event.payload as { invoiceId?: string }).invoiceId ?? "",
  );
  const [invoice] = await getDb()
    .select()
    .from(invoicesTable)
    .where(eq(invoicesTable.id, invoiceId))
    .limit(1);
  if (!invoice) return null;

  const canonical = await buildCanonical(invoiceId);
  return {
    invoice,
    canonical,
    idempotencyKey: `${invoiceId}:${invoice.invoiceNumber}`,
    attemptNo: event.attempts + 1,
  };
}

// The authority I/O stage deliberately owns no database context. A process
// crash after the rail accepts is recovered by the rail idempotency key and
// duplicate lookup; the durable outbox lease is reclaimed independently.
async function performInvoiceRailCall(
  prepared: PreparedInvoiceSubmit,
): Promise<InvoiceRailEffect> {
  const failover = await submitWithFailover(
    prepared.canonical,
    prepared.idempotencyKey,
  );
  let recovered: StampResult | null = null;
  let recoveryError: string | null = null;
  if (
    failover.result.status === "rejected" &&
    failover.result.errorCode === "MBS_DUPLICATE"
  ) {
    try {
      recovered = await recoverExistingStamp(
        prepared.canonical,
        prepared.idempotencyKey,
        failover.result.rail,
      );
    } catch (err) {
      if (!(err instanceof RailLookupError)) throw err;
      recoveryError = `${err.code}: stamp lookup failed`;
    }
  }
  return { failover, recovered, recoveryError };
}

async function finalizeInvoiceSubmit(
  event: OutboxEvent,
  prepared: PreparedInvoiceSubmit | null,
  effect: InvoiceRailEffect | null,
): Promise<HandlerOutcome> {
  if (!prepared || !effect) {
    const invoiceId = String(
      (event.payload as { invoiceId?: string }).invoiceId ?? "",
    );
    return { kind: "dead", error: `Invoice ${invoiceId} missing` };
  }
  const { invoice, canonical, idempotencyKey, attemptNo } = prepared;
  const invoiceId = invoice.id;
  const { result, sent, circuitOpen, retryAfter } = effect.failover;

  // Every breaker is open: nothing was sent, so there is no attempt to record
  // and none to burn — park until the earliest rail will take a probe (R96).
  if (circuitOpen) {
    return {
      kind: "park",
      until: retryAfter ?? new Date(Date.now() + railOpenCooldownMs()),
      error: "RAIL_UNAVAILABLE",
    };
  }

  // One row per rail actually CALLED this try, with the request sent and the
  // response received (CORE-02) — the record a dispute or an accreditation
  // review reads, so the invoice number alone was never enough. A failover
  // leaves the first rail's timeout or 5xx on the record too (R95); a breaker
  // refusal sent nothing and is not an attempt.
  for (const r of sent) {
    await getDb()
      .insert(submissionAttemptsTable)
      .values({
        invoiceId,
        rail: r.rail,
        attemptNo,
        idempotencyKey,
        correlationId: event.correlationId,
        status:
          r.status === "accepted"
            ? "accepted"
            : r.status === "rejected"
              ? "rejected"
              : "error",
        requestPayload: {
          invoiceNumber: invoice.invoiceNumber,
          idempotencyKey,
          canonical: canonical as unknown as Record<string, unknown>,
        },
        responsePayload: r.raw,
        errorCode: r.errorCode ?? null,
      });
  }

  if (result.status === "accepted") {
    await persistStamp(invoice, result, false);
    return { kind: "done" };
  }

  if (result.status === "rejected" && result.errorCode === "MBS_DUPLICATE") {
    if (effect.recoveryError) {
      return { kind: "retry", error: effect.recoveryError };
    }
    if (effect.recovered) {
      await getDb()
        .insert(submissionAttemptsTable)
        .values({
          invoiceId,
          rail: effect.recovered.rail,
          attemptNo,
          idempotencyKey,
          correlationId: event.correlationId,
          status: "accepted",
          requestPayload: { lookup: true, idempotencyKey },
          responsePayload: { ...effect.recovered.raw, recovered: true },
          errorCode: null,
        });
      await persistStamp(invoice, effect.recovered, true);
      return { kind: "done" };
    }
    // No rail knows the submission: keep the terminal rejection, but say so.
    await appendAudit({
      firmId: invoice.firmId,
      action: "invoice.stamp_recovery_failed",
      entityType: "invoice",
      entityId: invoiceId,
      after: { errorCode: result.errorCode, rail: result.rail },
    });
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
    return {
      kind: "retry",
      error: result.errorCode ?? "RAIL_ERROR",
      notBefore: retryAfterFrom(result),
    };
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
  await getDb()
    .insert(outboxTable)
    .values({
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

const HANDLERS: Record<string, (e: OutboxEvent) => Promise<HandlerOutcome>> = {
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
// The locking subquery is raw SQL (the builder cannot express FOR UPDATE SKIP
// LOCKED inside an UPDATE), but the UPDATE itself goes through the builder so
// the returned row is mapped to the schema's camelCase shape. A raw
// `RETURNING *` handed back snake_case columns, which left `maxAttempts`
// (and now `firstAttemptAt`/`parkCount`) undefined on the claimed event and
// silently disabled attempt-count dead-lettering (R96).
async function claimnext(): Promise<OutboxEvent | null> {
  const lockToken = randomUUID();
  const lockExpiresAt = new Date(Date.now() + outboxLeaseMs());
  const [event] = await getDb()
    .update(outboxTable)
    .set({
      status: "processing",
      lockedAt: sql`now()`,
      lockToken,
      lockExpiresAt,
    })
    .where(
      eq(
        outboxTable.id,
        sql`(
          SELECT id FROM outbox_events
          WHERE (status = 'pending' AND next_attempt_at <= now())
             OR (status = 'processing' AND (
                  lock_expires_at <= now()
                  OR (lock_expires_at IS NULL AND locked_at < now() - interval '5 minutes')
                ))
          ORDER BY created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )`,
      ),
    )
    .returning();
  return event ?? null;
}

class OutboxLeaseLost extends Error {}

async function lockActiveLease(event: OutboxEvent): Promise<void> {
  if (!event.lockToken) throw new OutboxLeaseLost("Claim has no lease token");
  const result = await getDb().execute<{ id: string }>(sql`
    SELECT id FROM outbox_events
    WHERE id = ${event.id}
      AND status = 'processing'
      AND lock_token = ${event.lockToken}
    FOR UPDATE
  `);
  const rows =
    (result as unknown as { rows?: { id: string }[] }).rows ??
    (result as unknown as { id: string }[]);
  if (rows.length !== 1) {
    throw new OutboxLeaseLost(`Lease lost for outbox event ${event.id}`);
  }
}

async function applyHandlerOutcome(
  event: OutboxEvent,
  outcome: HandlerOutcome,
): Promise<void> {
  const now = new Date();
  const attempts = event.attempts + 1;
  const firstAttemptAt = event.firstAttemptAt ?? now;
  const released = { lockedAt: null, lockToken: null, lockExpiresAt: null };
  if (outcome.kind === "park") {
    const until = new Date(
      outcome.until.getTime() + Math.random() * PARK_JITTER_MS,
    );
    await getDb()
      .update(outboxTable)
      .set({
        ...released,
        status: "pending",
        nextAttemptAt: until,
        parkedUntil: until,
        parkCount: event.parkCount + 1,
        lastError: `${outcome.error}: parked until ${until.toISOString()}`,
      })
      .where(eq(outboxTable.id, event.id));
    return;
  }
  if (outcome.kind === "done") {
    const containsInboundPayload = event.type.startsWith("inbound.");
    await getDb()
      .update(outboxTable)
      .set({
        ...released,
        status: "done",
        attempts,
        firstAttemptAt,
        parkedUntil: null,
        ...(containsInboundPayload ? { payload: { redacted: true } } : {}),
      })
      .where(eq(outboxTable.id, event.id));
    return;
  }
  if (outcome.kind === "dead") {
    await getDb()
      .update(outboxTable)
      .set({
        ...released,
        status: "dead",
        attempts,
        firstAttemptAt,
        parkedUntil: null,
        lastError: outcome.error,
        nextAttemptAt: now,
      })
      .where(eq(outboxTable.id, event.id));
    await openCaseForDeadEvent(event, outcome.error);
    return;
  }
  const next = retryDisposition(event, attempts, now, outcome.notBefore);
  await getDb()
    .update(outboxTable)
    .set({
      ...released,
      status: next.dead ? "dead" : "pending",
      attempts,
      firstAttemptAt: next.firstAttemptAt,
      parkedUntil: null,
      lastError: outcome.error,
      nextAttemptAt: next.nextAttemptAt,
    })
    .where(eq(outboxTable.id, event.id));
  if (next.dead) await openCaseForDeadEvent(event, outcome.error);
}

async function processOne(): Promise<boolean> {
  // The claim commits before any handler runs. This frees the pool while an
  // authority request is in flight; lockToken/lockExpiresAt make a crash
  // reclaimable and make a late worker's finalization fail closed.
  const event = await runInBypassContext(claimnextSafe);
  if (!event) return false;

  try {
    if (event.type === "invoice.submit") {
      const prepared = await runInBypassContext(() =>
        prepareInvoiceSubmit(event),
      );
      const effect = prepared ? await performInvoiceRailCall(prepared) : null;
      await runInBypassContext(
        async () => {
          await lockActiveLease(event);
          const outcome = await finalizeInvoiceSubmit(event, prepared, effect);
          await applyHandlerOutcome(event, outcome);
        },
        { correlationId: event.correlationId },
      );
    } else {
      await runInBypassContext(
        async () => {
          await lockActiveLease(event);
          const handler = HANDLERS[event.type];
          const outcome = handler
            ? await handler(event)
            : { kind: "dead" as const, error: `No handler for ${event.type}` };
          await applyHandlerOutcome(event, outcome);
        },
        { correlationId: event.correlationId },
      );
    }
  } catch (error) {
    if (error instanceof OutboxLeaseLost) {
      logger.warn(
        { eventId: event.id, correlationId: event.correlationId },
        "outbox lease expired before finalization; a new worker owns the event",
      );
      return true;
    }
    const message = error instanceof Error ? error.message : String(error);
    await runInBypassContext(
      async () => {
        try {
          await lockActiveLease(event);
        } catch (leaseError) {
          if (leaseError instanceof OutboxLeaseLost) return;
          throw leaseError;
        }
        const attempts = event.attempts + 1;
        const next = retryDisposition(event, attempts);
        await getDb()
          .update(outboxTable)
          .set({
            status: next.dead ? "dead" : "pending",
            attempts,
            firstAttemptAt: next.firstAttemptAt,
            parkedUntil: null,
            lockedAt: null,
            lockToken: null,
            lockExpiresAt: null,
            lastError: message,
            nextAttemptAt: next.nextAttemptAt,
          })
          .where(eq(outboxTable.id, event.id));
        if (next.dead) await openCaseForDeadEvent(event, message);
      },
      { correlationId: event.correlationId },
    );
  }
  return true;
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

// A claim failure must not be confused with an empty queue: a persistent
// one (permissions regression, schema drift) would
// otherwise make the pipeline process nothing while every dashboard stays
// green. Log/count it, then let the guarded pass report failure without
// killing the interval loop. The short claim transaction rolls back.
async function claimnextSafe(): Promise<OutboxEvent | null> {
  try {
    return await claimnext();
  } catch (err) {
    outboxClaimFailuresTotal.inc();
    logger.error({ err }, "outbox claim failed");
    throw err;
  }
}

// Compatibility export for the former in-transaction rail budget. It now
// defines the minimum durable lease around the transaction-free I/O stage.
export function transactionHoldBudgetMs(): number {
  return 4 * railTimeoutMs() + 30_000;
}

export function outboxLeaseMs(): number {
  const configured = Number(process.env.OUTBOX_LEASE_MS);
  const minimum = transactionHoldBudgetMs();
  return Number.isFinite(configured) && configured >= minimum
    ? Math.floor(configured)
    : minimum;
}

// Set by stopWorker (R95): a drain pass finishes the event in flight and
// then stops CLAIMING, so a backlog against a slow rail cannot carry the
// process past its graceful-shutdown deadline one claim at a time.
let stopping = false;

// Drain until no more ready events (bounded to avoid a hot loop).
export async function drain(max = 50): Promise<number> {
  let processed = 0;
  for (let i = 0; i < max; i++) {
    if (stopping) break;
    const did = await processOne();
    if (!did) break;
    processed++;
  }
  return processed;
}

// Reconciliation (INT-09): re-enqueue invoices stuck in `submitted` with no
// stamp and no live outbox row (e.g. a crash mid-flight). Before resubmitting,
// ask the rail whether it already issued a stamp for that submission (R97): a
// crash between the rail's acceptance and our stamp write is exactly the case
// where a blind re-send would come back MBS_DUPLICATE against a live rail. A
// recovered stamp is persisted in place; only an unknown submission is
// re-queued. Returns the number of invoices re-queued (the operator counter);
// recoveries are logged.
// Each stuck invoice is prepared and finalized in short transactions, with the
// rail lookup between them while no pooled connection is held. A pass takes at
// most RECONCILE_BATCH invoices, oldest first; the next pass continues where
// it left off.
const RECONCILE_BATCH = 50;

type ReconcileOutcome = "skipped" | "dead" | "recovered" | "requeued";

async function reconcileOne(invoice: InvoiceRow): Promise<ReconcileOutcome> {
  const idempotencyKey = `${invoice.id}:${invoice.invoiceNumber}`;
  const prepared = await runInBypassContext(async () => {
    const [stamp] = await getDb()
      .select({ id: stampRecordsTable.id })
      .from(stampRecordsTable)
      .where(eq(stampRecordsTable.invoiceId, invoice.id))
      .limit(1);
    if (stamp) return { outcome: "skipped" as const, canonical: null };
    const open = await getDb()
      .select({ status: outboxTable.status })
      .from(outboxTable)
      .where(
        and(
          eq(outboxTable.aggregateId, invoice.id),
          ne(outboxTable.status, "done"),
        ),
      );
    if (open.some((row) => row.status === "dead")) {
      return { outcome: "dead" as const, canonical: null };
    }
    if (open.length > 0) {
      return { outcome: "skipped" as const, canonical: null };
    }
    const canonical = await buildCanonical(invoice.id).catch((err: unknown) => {
      logger.warn(
        { invoiceId: invoice.id, err },
        "reconcile could not build the canonical invoice; re-queuing",
      );
      return null;
    });
    return { outcome: null, canonical };
  });
  if (prepared.outcome) return prepared.outcome;

  // No database transaction is open across the authority lookup.
  const existing = prepared.canonical
    ? await recoverExistingStamp(prepared.canonical, idempotencyKey).catch(
        (err: unknown) => {
          logger.warn(
            { invoiceId: invoice.id, err },
            "reconcile could not ask the rail for an existing stamp; re-queuing",
          );
          return null;
        },
      )
    : null;

  return runInBypassContext(async () => {
    // Re-check after I/O: another worker may have stamped or queued the invoice
    // while this lookup was in flight.
    const [stamp] = await getDb()
      .select({ id: stampRecordsTable.id })
      .from(stampRecordsTable)
      .where(eq(stampRecordsTable.invoiceId, invoice.id))
      .limit(1);
    if (stamp) return "skipped";
    const open = await getDb()
      .select({ status: outboxTable.status })
      .from(outboxTable)
      .where(
        and(
          eq(outboxTable.aggregateId, invoice.id),
          ne(outboxTable.status, "done"),
        ),
      );
    if (open.some((row) => row.status === "dead")) return "dead";
    if (open.length > 0) return "skipped";
    if (existing) {
      await getDb()
        .insert(submissionAttemptsTable)
        .values({
          invoiceId: invoice.id,
          rail: existing.rail,
          attemptNo: 0,
          idempotencyKey,
          status: "accepted",
          requestPayload: { lookup: true, idempotencyKey, source: "reconcile" },
          responsePayload: { ...existing.raw, recovered: true },
          errorCode: null,
        });
      await persistStamp(invoice, existing, true);
      return "recovered";
    }
    await getDb()
      .insert(outboxTable)
      .values({
        aggregateType: "invoice",
        aggregateId: invoice.id,
        type: "invoice.submit",
        payload: { invoiceId: invoice.id },
      });
    return "requeued";
  });
}

export async function reconcile(): Promise<number> {
  // Only invoices a pass can ACT on fill the batch: no stamp row yet and no
  // outbox row still live or dead-lettered (a dead row waits for an operator
  // replay, R96). Otherwise fifty permanently-stuck invoices would starve
  // every newer one. reconcileOne re-checks inside its own transaction.
  const stuck = await runInBypassContext(() =>
    getDb()
      .select()
      .from(invoicesTable)
      .where(
        and(
          eq(invoicesTable.status, "submitted"),
          notExists(
            getDb()
              .select({ one: sql`1` })
              .from(stampRecordsTable)
              .where(eq(stampRecordsTable.invoiceId, invoicesTable.id)),
          ),
          notExists(
            getDb()
              .select({ one: sql`1` })
              .from(outboxTable)
              .where(
                and(
                  // aggregate_id is text (any aggregate), invoices.id a uuid.
                  eq(outboxTable.aggregateId, sql`${invoicesTable.id}::text`),
                  ne(outboxTable.status, "done"),
                ),
              ),
          ),
        ),
      )
      .orderBy(asc(invoicesTable.createdAt))
      .limit(RECONCILE_BATCH),
  );
  let requeued = 0;
  let recovered = 0;
  let deadLettered = 0;
  for (const invoice of stuck) {
    const outcome = await reconcileOne(invoice);
    if (outcome === "dead") deadLettered++;
    else if (outcome === "recovered") recovered++;
    else if (outcome === "requeued") requeued++;
  }
  if (stuck.length === RECONCILE_BATCH) {
    logger.info(
      { batch: RECONCILE_BATCH },
      "reconcile pass hit its batch size; the next pass continues",
    );
  }
  if (recovered > 0 || deadLettered > 0) {
    logger.info(
      { requeued, recovered, deadLettered },
      "reconcile pass: dead-lettered invoices wait for an operator replay",
    );
  }
  return requeued;
}

// Duplicate-stamp reconciliation (INT-09), append-only (CORE-02). Duplicates are
// prevented at write by the unique(invoiceId) constraint + idempotent insert, so
// this sweep is a defensive detector for any historical/anomalous duplicate. It
// NEVER deletes a stamp: stamps are immutable post-submission. Instead it names
// the canonical (earliest) stamp and records the superseded ones in an audit
// event, so every reader resolves deterministically to the same canonical stamp.
async function reconcileDuplicateStamps(): Promise<number> {
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
      .set({
        status: "pending",
        attempts: 0,
        nextAttemptAt: new Date(),
        lastError: null,
        // A replay starts a fresh retry horizon (R96).
        firstAttemptAt: null,
        parkedUntil: null,
        parkCount: 0,
        lockedAt: null,
        lockToken: null,
        lockExpiresAt: null,
      })
      .where(and(eq(outboxTable.id, outboxId), eq(outboxTable.status, "dead")));
  });
}

// The events still on their way (R102): pending rows that have already
// failed at least once, or are parked behind a breaker — the Desk's view of
// "what is retrying and why", bounded like every list.
export interface QueuePage {
  items: OutboxEvent[];
  nextCursor: string | null;
}

type QueueCursor = {
  kind: "dead" | "retrying";
  primary: string;
  createdAt: string;
  id: string;
};

const UUID_CURSOR_VALUE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function encodeQueueCursor(cursor: QueueCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeQueueCursor(
  raw: string | undefined,
  kind: QueueCursor["kind"],
): QueueCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as Partial<QueueCursor>;
    if (
      parsed.kind !== kind ||
      typeof parsed.primary !== "string" ||
      Number.isNaN(Date.parse(parsed.primary)) ||
      typeof parsed.createdAt !== "string" ||
      Number.isNaN(Date.parse(parsed.createdAt)) ||
      typeof parsed.id !== "string" ||
      !UUID_CURSOR_VALUE.test(parsed.id)
    ) {
      throw new Error("shape");
    }
    return parsed as QueueCursor;
  } catch {
    throw new DomainError(
      "INVALID_CURSOR",
      "The queue cursor is invalid or belongs to a different list",
      400,
    );
  }
}

function queuePage(
  rows: OutboxEvent[],
  limit: number,
  kind: QueueCursor["kind"],
  primary: (row: OutboxEvent) => Date,
): QueuePage {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > limit && last
        ? encodeQueueCursor({
            kind,
            primary: primary(last).toISOString(),
            createdAt: last.createdAt.toISOString(),
            id: last.id,
          })
        : null,
  };
}

export async function listRetrying(bounds: {
  limit: number;
  cursor?: string | undefined;
}): Promise<QueuePage> {
  return runInBypassContext(async () => {
    const cursor = decodeQueueCursor(bounds.cursor, "retrying");
    // node-postgres materializes timestamps as millisecond-precision Dates.
    // Normalize PostgreSQL's microseconds in both ORDER BY and comparisons so
    // the boundary row cannot repeat on the next cursor page.
    const retryAt = sql<Date>`date_trunc('milliseconds', ${outboxTable.nextAttemptAt})`;
    const createdAt = sql<Date>`date_trunc('milliseconds', ${outboxTable.createdAt})`;
    const retrying = and(
      eq(outboxTable.status, "pending"),
      or(gt(outboxTable.attempts, 0), isNotNull(outboxTable.parkedUntil)),
    );
    const after = cursor
      ? or(
          gt(retryAt, new Date(cursor.primary)),
          and(
            eq(retryAt, new Date(cursor.primary)),
            or(
              gt(createdAt, new Date(cursor.createdAt)),
              and(
                eq(createdAt, new Date(cursor.createdAt)),
                gt(outboxTable.id, cursor.id),
              ),
            ),
          ),
        )
      : undefined;
    const rows = await getDb()
      .select()
      .from(outboxTable)
      .where(after ? and(retrying, after) : retrying)
      .orderBy(asc(retryAt), asc(createdAt), asc(outboxTable.id))
      .limit(bounds.limit + 1);
    const redacted = rows.map((row) =>
      row.type === "inbound.email" || row.type === "inbound.whatsapp"
        ? { ...row, payload: { redacted: true } }
        : row,
    );
    return queuePage(
      redacted,
      bounds.limit,
      "retrying",
      (row) => row.nextAttemptAt,
    );
  });
}

export async function listDeadLetters(bounds: {
  limit: number;
  cursor?: string | undefined;
}): Promise<QueuePage> {
  return runInBypassContext(async () => {
    const cursor = decodeQueueCursor(bounds.cursor, "dead");
    const createdAt = sql<Date>`date_trunc('milliseconds', ${outboxTable.createdAt})`;
    const after = cursor
      ? or(
          gt(createdAt, new Date(cursor.createdAt)),
          and(
            eq(createdAt, new Date(cursor.createdAt)),
            gt(outboxTable.id, cursor.id),
          ),
        )
      : undefined;
    const rows = await getDb()
      .select()
      .from(outboxTable)
      .where(
        after
          ? and(eq(outboxTable.status, "dead"), after)
          : eq(outboxTable.status, "dead"),
      )
      .orderBy(asc(createdAt), asc(outboxTable.id))
      .limit(bounds.limit + 1);
    const redacted = rows.map((row) =>
      row.type === "inbound.email" || row.type === "inbound.whatsapp"
        ? { ...row, payload: { redacted: true } }
        : row,
    );
    return queuePage(redacted, bounds.limit, "dead", (row) => row.createdAt);
  });
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

registerSweep("pipeline.retention", sweepPipelineRetention, {
  critical: false,
});

// Outbox gauges (R96): depth by state, the age of the oldest ready event and
// the dead-letter count — the series an alert on "the pipeline is stuck"
// reads. Set by a sweep (every minute; on Autoscale, every external ping)
// rather than at scrape time, so /api/metrics never touches the database.
export async function sweepOutboxGauges(): Promise<void> {
  const [row] = (
    await runInBypassContext(() =>
      getDb().execute(sql`
      SELECT
        count(*) FILTER (WHERE status = 'pending' AND (parked_until IS NULL OR parked_until <= now()))::int AS ready,
        count(*) FILTER (WHERE status = 'pending' AND parked_until > now())::int AS parked,
        count(*) FILTER (WHERE status = 'processing')::int AS processing,
        count(*) FILTER (WHERE status = 'dead')::int AS dead,
        coalesce(
          extract(epoch FROM now() - min(created_at) FILTER (WHERE status = 'pending')),
          0
        )::float AS oldest_pending_age_seconds
      FROM outbox_events
    `),
    )
  ).rows as {
    ready: number;
    parked: number;
    processing: number;
    dead: number;
    oldest_pending_age_seconds: number;
  }[];
  outboxEvents.set({ state: "pending" }, row?.ready ?? 0);
  outboxEvents.set({ state: "parked" }, row?.parked ?? 0);
  outboxEvents.set({ state: "processing" }, row?.processing ?? 0);
  outboxEvents.set({ state: "dead" }, row?.dead ?? 0);
  outboxOldestPendingAgeSeconds.set(
    Number(row?.oldest_pending_age_seconds ?? 0),
  );
}

registerSweep("pipeline.gauges", sweepOutboxGauges);

// Module-level reentrancy guards shared by the interval loops AND the external
// wake-up trigger (see runScheduledWorkOnce): a run that exceeds its period —
// or an external trigger landing mid-pass — must skip, not overlap, or the
// sweep/reconcile duplication races return (CON-M3).
let draining = false;
let reconciling = false;
let sweeping = false;

// A lost lock session stops this worker's scheduling (distributed-lock.ts
// owns the lock mechanics; the stop policy stays here with the timers).
const withPassLock = <T>(lockId: number, task: () => Promise<T>) =>
  withDistributedLock(lockId, task, stopWorker);

// The guarded pass bodies shared by the interval loops (startWorker) and the
// external wake-up trigger (runScheduledWorkOnce). Each skips — never overlaps
// — when its prior run is still in flight, isolates its own errors (logged,
// not silently swallowed), and reports whether it actually ran.

interface SweepPassResult {
  ran: boolean;
  failures: number;
  /** Names of the sweeps that failed (static identifiers, never tenant data). */
  failedSweeps: string[];
  /** How many of those are critical (absent `critical: false`). */
  criticalFailures: number;
}

const passResult = (
  ran: boolean,
  failures: number,
  report: SweepFailureReport,
): SweepPassResult => ({
  ran,
  failures,
  failedSweeps: [...report.failed],
  criticalFailures: report.critical,
});

async function guardedSweepPass(): Promise<SweepPassResult> {
  if (sweeping || stopping)
    return passResult(false, 0, { failed: [], critical: 0 });
  sweeping = true;
  let report!: (result: SweepPassResult) => void;
  const response = new Promise<SweepPassResult>((resolve) => {
    report = resolve;
  });
  track(
    (async () => {
      const failed: SweepFailureReport = { failed: [], critical: 0 };
      try {
        const result = await withPassLock(991_102, async () => {
          const owned: Promise<unknown>[] = [];
          try {
            const failures = await runRegisteredSweeps(owned, failed);
            // A timeout must report failure promptly while retaining ownership
            // until the underlying work settles. Healthy passes await unlock.
            if (failures > 0) report(passResult(true, failures, failed));
            return failures;
          } finally {
            // The caller may stop waiting, but another process must not acquire
            // our pass lock while a timed-out sweep still has side effects —
            // up to the settle ceiling, past which ownership is released and
            // the stuck sweep is alerted (R105).
            await settleOwnedWork(owned);
          }
        });
        report(passResult(result.acquired, result.value ?? 0, failed));
      } catch (err) {
        // The pass itself (lock acquisition / release) failed — the sweeps
        // inside never throw past runSweepsOnce. Count it under its own
        // label so an unhandled rejection never escapes the interval.
        sweepErrorsTotal.inc({ sweep: "pass", kind: "error" });
        logger.error({ err }, "compliance sweep pass failed");
        report(passResult(false, 1, { failed: ["pass"], critical: 1 }));
      } finally {
        sweeping = false;
      }
    })(),
  );
  return response;
}

/** One guarded sweep pass on demand (the external trigger and tests). */
export async function runSweepPassOnce(): Promise<boolean> {
  return (await guardedSweepPass()).ran;
}

async function guardedDrainPass(): Promise<{
  ran: boolean;
  drained: number;
  failed: boolean;
}> {
  if (draining || stopping) return { ran: false, drained: 0, failed: false };
  draining = true;
  return track(
    (async () => {
      try {
        const drained = await drain();
        return { ran: true, drained, failed: false };
      } catch (err) {
        logger.error({ err }, "outbox drain failed");
        return { ran: false, drained: 0, failed: true };
      } finally {
        draining = false;
      }
    })(),
  );
}

// Duplicate-stamp reconciliation hunts a condition the unique(invoiceId)
// constraint + idempotent insert already prevent at write time — it exists
// only to surface historical/anomalous rows. Scanning for that every 30s
// bought nothing, so it rides the reconcile loop at most hourly (module-level
// timestamp, advanced BEFORE the run so a failing pass also waits out the
// hour). The stuck-submission re-enqueue stays on the fast cadence — that one
// is real recovery work.
const DUPLICATE_STAMP_INTERVAL_MS = 60 * 60 * 1000;
let lastDuplicateStampSweep = 0;

async function guardedReconcilePass(): Promise<{
  ran: boolean;
  failed: boolean;
}> {
  if (reconciling || stopping) return { ran: false, failed: false };
  reconciling = true;
  return track(
    (async () => {
      try {
        const result = await withPassLock(991_103, async () => {
          await reconcile();
          if (
            Date.now() - lastDuplicateStampSweep >=
            DUPLICATE_STAMP_INTERVAL_MS
          ) {
            lastDuplicateStampSweep = Date.now();
            await reconcileDuplicateStamps();
          }
        });
        return { ran: result.acquired, failed: false };
      } catch (err) {
        logger.error({ err }, "pipeline reconcile sweep failed");
        return { ran: false, failed: true };
      } finally {
        reconciling = false;
      }
    })(),
  );
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
  failed: {
    drain: boolean;
    reconcile: boolean;
    sweeps: number;
    /** Static sweep names (R105) — safe to return to the external trigger. */
    sweepNames: string[];
    criticalSweeps: number;
  };
}> {
  const sweeps = await guardedSweepPass();
  const drain = await guardedDrainPass();
  const reconcile = await guardedReconcilePass();
  return {
    ran: { drain: drain.ran, reconcile: reconcile.ran, sweeps: sweeps.ran },
    drained: drain.drained,
    failed: {
      drain: drain.failed,
      reconcile: reconcile.failed,
      sweeps: sweeps.failures,
      sweepNames: sweeps.failedSweeps,
      criticalSweeps: sweeps.criticalFailures,
    },
  };
}

// In-process polling worker (modular monolith). Guarded against double-start.
// A fast loop drains the outbox; a slower loop runs the scheduled
// reconciliation sweeps (stuck-submission re-enqueue + duplicate-stamp
// collapse) so INT-09 recovery does not depend on a manual operator trigger;
// a third loop runs the registered R2 compliance sweeps.
export function startWorker(intervalMs = 1_500): void {
  stopping = false;
  resumeSweeps();
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

/**
 * Clear the stop flag without arming timers — for a test that drained after
 * stopWorker(), or an instance resumed by hand. startWorker clears it too.
 */
export function resumeWorker(): void {
  stopping = false;
  resumeSweeps();
}

export function stopWorker(): void {
  stopping = true;
  stopSweeps();
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
