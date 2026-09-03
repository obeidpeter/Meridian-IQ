import { and, asc, eq, lt, ne, sql } from "drizzle-orm";
import {
  getDb,
  pool,
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
  type StampResult,
} from "../rails/adapter";
import { RailLookupError } from "../rails/faults";
import { railTimeoutMs } from "../rails/transports/http";
import { openInvoiceCase } from "../desk/cases";
import { isRetriable } from "../errors";
import { logger } from "../../lib/logger";
import {
  sweepRunsTotal,
  sweepErrorsTotal,
  sweepLastSuccess,
  sweepLastSuccessBySweep,
  sweepDurationSeconds,
  outboxClaimFailuresTotal,
  outboxEvents,
  outboxOldestPendingAgeSeconds,
} from "../../lib/metrics";

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
  const raw = Math.min(outboxMaxBackoffMs(), BASE_BACKOFF_MS * Math.pow(2, attempts));
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
    notBefore && notBefore.getTime() > backoffAt.getTime() ? notBefore : backoffAt;
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
  const { result, sent, circuitOpen, retryAfter } = await submitWithFailover(
    canonical,
    idempotencyKey,
  );

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
    // The rail already holds a stamp for this submission — an earlier try
    // was accepted but its result never reached us. Recover it instead of
    // failing an invoice the authority has stamped (R97).
    let recovered: StampResult | null;
    try {
      recovered = await recoverExistingStamp(canonical, idempotencyKey, result.rail);
    } catch (err) {
      if (!(err instanceof RailLookupError)) throw err;
      // The rail could not be ASKED (timeout, 5xx, refused credentials): the
      // stamp may well exist, so this is a retry, never a terminal failure.
      // The 409 attempt row above stays on the record.
      return { kind: "retry", error: `${err.code}: stamp lookup failed` };
    }
    if (recovered) {
      await getDb()
        .insert(submissionAttemptsTable)
        .values({
          invoiceId,
          rail: recovered.rail,
          attemptNo,
          idempotencyKey,
          status: "accepted",
          requestPayload: { lookup: true, idempotencyKey },
          responsePayload: { ...recovered.raw, recovered: true },
          errorCode: null,
        });
      await persistStamp(invoice, recovered, true);
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
// The locking subquery is raw SQL (the builder cannot express FOR UPDATE SKIP
// LOCKED inside an UPDATE), but the UPDATE itself goes through the builder so
// the returned row is mapped to the schema's camelCase shape. A raw
// `RETURNING *` handed back snake_case columns, which left `maxAttempts`
// (and now `firstAttemptAt`/`parkCount`) undefined on the claimed event and
// silently disabled attempt-count dead-lettering (R96).
async function claimnext(): Promise<OutboxEvent | null> {
  const [event] = await getDb()
    .update(outboxTable)
    .set({ status: "processing", lockedAt: sql`now()` })
    .where(
      eq(
        outboxTable.id,
        sql`(
          SELECT id FROM outbox_events
          WHERE status = 'pending' AND next_attempt_at <= now()
          ORDER BY created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )`,
      ),
    )
    .returning();
  return event ?? null;
}

async function processOne(): Promise<boolean> {
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
      // The rail call runs inside this transaction (R95): bound the hold so a
      // deployment default shorter than the transport budget cannot kill the
      // session mid-call, and a hung call cannot pin the connection forever.
      // An event makes at most four rail calls (two submits, two lookups).
      await getDb().execute(
        sql.raw(
          `SET LOCAL idle_in_transaction_session_timeout = '${transactionHoldBudgetMs()}ms'`,
        ),
      );
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
      const now = new Date();
      const attempts = event.attempts + 1;
      const firstAttemptAt = event.firstAttemptAt ?? now;
      if (outcome.kind === "park") {
        // Parked (R96): status stays pending so the drain index still holds
        // the row, the attempt counter and the horizon clock do not move,
        // and the wake-up is jittered so a parked backlog does not probe
        // the rail in one wave.
        const until = new Date(
          outcome.until.getTime() + Math.random() * PARK_JITTER_MS,
        );
        await getDb()
          .update(outboxTable)
          .set({
            status: "pending",
            lockedAt: null,
            nextAttemptAt: until,
            parkedUntil: until,
            parkCount: event.parkCount + 1,
            lastError: `${outcome.error}: parked until ${until.toISOString()}`,
          })
          .where(eq(outboxTable.id, event.id));
      } else if (outcome.kind === "done") {
        const containsInboundPayload = event.type.startsWith("inbound.");
        await getDb()
          .update(outboxTable)
          .set({
            status: "done",
            attempts,
            firstAttemptAt,
            parkedUntil: null,
            lockedAt: null,
            ...(containsInboundPayload ? { payload: { redacted: true } } : {}),
          })
          .where(eq(outboxTable.id, event.id));
      } else if (outcome.kind === "dead") {
        await getDb()
          .update(outboxTable)
          .set({
            status: "dead",
            attempts,
            firstAttemptAt,
            parkedUntil: null,
            lockedAt: null,
            lastError: outcome.error,
            nextAttemptAt: now,
          })
          .where(eq(outboxTable.id, event.id));
        await openCaseForDeadEvent(event, outcome.error);
      } else {
        const next = retryDisposition(event, attempts, now, outcome.notBefore);
        await getDb()
          .update(outboxTable)
          .set({
            status: next.dead ? "dead" : "pending",
            attempts,
            firstAttemptAt: next.firstAttemptAt,
            parkedUntil: null,
            lockedAt: null,
            lastError: outcome.error,
            nextAttemptAt: next.nextAttemptAt,
          })
          .where(eq(outboxTable.id, event.id));
        if (next.dead) await openCaseForDeadEvent(event, outcome.error);
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
      const next = retryDisposition(event, attempts);
      await getDb()
        .update(outboxTable)
        .set({
          status: next.dead ? "dead" : "pending",
          attempts,
          firstAttemptAt: next.firstAttemptAt,
          parkedUntil: null,
          lockedAt: null,
          lastError: message,
          nextAttemptAt: next.nextAttemptAt,
        })
        .where(eq(outboxTable.id, event.id));
      if (next.dead) await openCaseForDeadEvent(event, message);
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

// The worst an event can hold its transaction: four rail calls plus slack.
export function transactionHoldBudgetMs(): number {
  return 4 * railTimeoutMs() + 30_000;
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
// Each stuck invoice is reconciled in its OWN short transaction (R95): the
// rail lookups it may make are bounded per call, but a pass over K invoices
// against a hung rail must not hold one connection and the reconcile lock for
// K × that budget. A pass takes at most RECONCILE_BATCH invoices, oldest
// first; the next pass continues where it left off.
const RECONCILE_BATCH = 50;

type ReconcileOutcome = "skipped" | "dead" | "recovered" | "requeued";

async function reconcileOne(invoice: InvoiceRow): Promise<ReconcileOutcome> {
  const [stamp] = await getDb()
    .select({ id: stampRecordsTable.id })
    .from(stampRecordsTable)
    .where(eq(stampRecordsTable.invoiceId, invoice.id))
    .limit(1);
  if (stamp) return "skipped";
  // A live row (pending — parked or not — or processing) is already on
  // its way. A DEAD row is terminal until an operator replays it (R96):
  // resurrecting it here would re-queue a fresh row every pass, burn a
  // new retry budget, and mint a new alert and Desk case each time.
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
  const idempotencyKey = `${invoice.id}:${invoice.invoiceNumber}`;
  // Fail soft: an invoice whose canonical form no longer builds (or a rail
  // lookup that could not be answered) is re-queued so the submit handler
  // records the failure with its reason, rather than aborting the pass.
  const existing = await buildCanonical(invoice.id)
    .then((canonical) => recoverExistingStamp(canonical, idempotencyKey))
    .catch((err: unknown) => {
      logger.warn(
        { invoiceId: invoice.id, err },
        "reconcile could not ask the rail for an existing stamp; re-queuing",
      );
      return null;
    });
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
}

export async function reconcile(): Promise<number> {
  const stuck = await runInBypassContext(() =>
    getDb()
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.status, "submitted"))
      .orderBy(asc(invoicesTable.createdAt))
      .limit(RECONCILE_BATCH),
  );
  let requeued = 0;
  let recovered = 0;
  let deadLettered = 0;
  for (const invoice of stuck) {
    const outcome = await runInBypassContext(() => reconcileOne(invoice));
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
      })
      .where(and(eq(outboxTable.id, outboxId), eq(outboxTable.status, "dead")));
  });
}

export async function listDeadLetters(): Promise<OutboxEvent[]> {
  return runInBypassContext(async () => {
    const rows = await getDb()
      .select()
      .from(outboxTable)
      .where(eq(outboxTable.status, "dead"))
      .orderBy(asc(outboxTable.createdAt));
    return rows.map((row) =>
      row.type === "inbound.email" || row.type === "inbound.whatsapp"
        ? { ...row, payload: { redacted: true } }
        : row,
    );
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

// Registered by feature modules at import time so the worker core does not
// import them. Sweep hygiene (R101): every sweep is NAMED — the name labels
// its error counter, its last-success gauge and its duration histogram, and
// is the word in the log line — and runs under a per-sweep timeout so one
// hung sweep cannot pin the whole pass (and with it every later tick, which
// the reentrancy guard would skip forever). A timed-out sweep's promise is
// abandoned, not cancelled; the pass moves on and the counter says so.
export interface RegisteredSweep {
  name: string;
  run: () => Promise<unknown>;
  /** 0 = the deployment default (SWEEP_TIMEOUT_MS), read at run time. */
  timeoutMs: number;
}
const SWEEPS: RegisteredSweep[] = [];
const SWEEP_NAME = /^[a-z][a-z0-9_.-]{1,63}$/;
const DEFAULT_SWEEP_TIMEOUT_MS = 120_000;

export function defaultSweepTimeoutMs(): number {
  const configured = Number(process.env.SWEEP_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_SWEEP_TIMEOUT_MS;
}

export function registerSweep(
  name: string,
  sweep: () => Promise<unknown>,
  opts: { timeoutMs?: number } = {},
): void {
  if (!SWEEP_NAME.test(name)) {
    throw new Error(`Sweep name "${name}" must match ${SWEEP_NAME}`);
  }
  if (SWEEPS.some((s) => s.name === name)) {
    throw new Error(`Sweep "${name}" is already registered`);
  }
  SWEEPS.push({ name, run: sweep, timeoutMs: opts.timeoutMs ?? 0 });
}

/** Remove a sweep by name (tests register salted sweeps and take them out). */
export function unregisterSweep(name: string): boolean {
  const at = SWEEPS.findIndex((s) => s.name === name);
  if (at === -1) return false;
  SWEEPS.splice(at, 1);
  return true;
}

export function listSweeps(): { name: string; timeoutMs: number }[] {
  return SWEEPS.map((s) => ({
    name: s.name,
    timeoutMs: s.timeoutMs || defaultSweepTimeoutMs(),
  }));
}

export class SweepTimeoutError extends Error {
  constructor(
    readonly sweep: string,
    readonly timeoutMs: number,
  ) {
    super(`Sweep "${sweep}" exceeded ${timeoutMs}ms`);
    this.name = "SweepTimeoutError";
  }
}

function withSweepTimeout<T>(
  name: string,
  work: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new SweepTimeoutError(name, timeoutMs)),
      timeoutMs,
    );
    timer.unref?.();
  });
  return Promise.race([work, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
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

registerSweep("pipeline.retention", sweepPipelineRetention);

// Outbox gauges (R96): depth by state, the age of the oldest ready event and
// the dead-letter count — the series an alert on "the pipeline is stuck"
// reads. Set by a sweep (every minute; on Autoscale, every external ping)
// rather than at scrape time, so /api/metrics never touches the database.
export async function sweepOutboxGauges(): Promise<void> {
  const [row] = (
    await getDb().execute(sql`
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
    `)
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
  outboxOldestPendingAgeSeconds.set(Number(row?.oldest_pending_age_seconds ?? 0));
}

registerSweep("pipeline.gauges", sweepOutboxGauges);

// Module-level reentrancy guards shared by the interval loops AND the external
// wake-up trigger (see runScheduledWorkOnce): a run that exceeds its period —
// or an external trigger landing mid-pass — must skip, not overlap, or the
// sweep/reconcile duplication races return (CON-M3).
let draining = false;
let reconciling = false;
let sweeping = false;

// In-flight passes, so a graceful shutdown (lib/shutdown.ts) can wait for
// the pass that is running rather than cut it off mid-transaction.
const inFlight = new Set<Promise<unknown>>();
function track<T>(pass: Promise<T>): Promise<T> {
  inFlight.add(pass);
  void pass.finally(() => inFlight.delete(pass)).catch(() => {});
  return pass;
}

/** Resolve true once every in-flight pass has settled, false on timeout. */
export async function awaitWorkerIdle(timeoutMs: number): Promise<boolean> {
  if (inFlight.size === 0) return true;
  const settled = Promise.allSettled([...inFlight]).then(() => true);
  const deadline = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([settled, deadline]);
}

export function inFlightPasses(): number {
  return inFlight.size;
}

async function withDistributedLock<T>(
  lockId: number,
  task: () => Promise<T>,
): Promise<{ acquired: boolean; value?: T }> {
  const client = await pool.connect();
  let acquired = false;
  let taskError: unknown;
  let releaseError: Error | undefined;
  try {
    const result = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS acquired",
      [lockId],
    );
    acquired = result.rows[0]?.acquired === true;
    if (!acquired) return { acquired: false };
    return { acquired: true, value: await task() };
  } catch (error) {
    taskError = error;
    throw error;
  } finally {
    if (acquired) {
      try {
        const result = await client.query<{ unlocked: boolean }>(
          "SELECT pg_advisory_unlock($1) AS unlocked",
          [lockId],
        );
        if (result.rows[0]?.unlocked !== true) {
          throw new Error("Pipeline advisory lock was not held at release");
        }
      } catch (error) {
        releaseError =
          error instanceof Error ? error : new Error(String(error));
        logger.error({ err: releaseError, lockId }, "advisory unlock failed");
      }
    }
    // Destroy a session whose unlock failed so a session-level lock cannot be
    // returned to the pool and strand all future sweep attempts.
    client.release(releaseError);
    if (!taskError && releaseError) throw releaseError;
  }
}

// The guarded pass bodies shared by the interval loops (startWorker) and the
// external wake-up trigger (runScheduledWorkOnce). Each skips — never overlaps
// — when its prior run is still in flight, isolates its own errors (logged,
// not silently swallowed), and reports whether it actually ran.

async function guardedSweepPass(): Promise<boolean> {
  if (sweeping) return false;
  sweeping = true;
  return track(
    (async () => {
      try {
        const result = await withDistributedLock(991_102, runSweepPass);
        return result.acquired;
      } catch (err) {
        // The pass itself (lock acquisition / release) failed — the sweeps
        // inside never throw past runSweepsOnce. Count it under its own
        // label so an unhandled rejection never escapes the interval.
        sweepErrorsTotal.inc({ sweep: "pass", kind: "error" });
        logger.error({ err }, "compliance sweep pass failed");
        return false;
      } finally {
        sweeping = false;
      }
    })(),
  );
}

/** One guarded sweep pass on demand (the external trigger and tests). */
export function runSweepPassOnce(): Promise<boolean> {
  return guardedSweepPass();
}

async function guardedDrainPass(): Promise<{ ran: boolean; drained: number }> {
  if (draining) return { ran: false, drained: 0 };
  draining = true;
  return track(
    (async () => {
      try {
        const drained = await drain();
        return { ran: true, drained };
      } catch (err) {
        logger.error({ err }, "outbox drain failed");
        return { ran: false, drained: 0 };
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

async function guardedReconcilePass(): Promise<boolean> {
  if (reconciling) return false;
  reconciling = true;
  return track(
    (async () => {
      try {
        const result = await withDistributedLock(991_103, async () => {
          await reconcile();
          if (
            Date.now() - lastDuplicateStampSweep >=
            DUPLICATE_STAMP_INTERVAL_MS
          ) {
            lastDuplicateStampSweep = Date.now();
            await reconcileDuplicateStamps();
          }
        });
        return result.acquired;
      } catch (err) {
        logger.error({ err }, "pipeline reconcile sweep failed");
        return false;
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
// contend for pool connections; a failing or timed-out sweep is counted under
// its NAME and logged, not silently dropped, and does not abort its siblings.
// Exported over an explicit list so a test can drive it without touching the
// registry.
export async function runSweepsOnce(sweeps: RegisteredSweep[]): Promise<number> {
  let failures = 0;
  for (const sweep of sweeps) {
    const timeoutMs = sweep.timeoutMs || defaultSweepTimeoutMs();
    const stop = sweepDurationSeconds.startTimer({ sweep: sweep.name });
    try {
      await withSweepTimeout(sweep.name, sweep.run(), timeoutMs);
      sweepLastSuccessBySweep.setToCurrentTime({ sweep: sweep.name });
      stop({ outcome: "ok" });
    } catch (err) {
      failures += 1;
      const kind = err instanceof SweepTimeoutError ? "timeout" : "error";
      sweepErrorsTotal.inc({ sweep: sweep.name, kind });
      stop({ outcome: kind });
      logger.error(
        { err, sweep: sweep.name, timeoutMs },
        "compliance sweep failed",
      );
    }
  }
  return failures;
}

async function runSweepPass(): Promise<void> {
  const failures = await runSweepsOnce(SWEEPS);
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
  stopping = false;
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
  stopping = true;
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
