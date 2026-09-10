import { createHash } from "node:crypto";
import { asc, desc, eq, gt, sql } from "drizzle-orm";
import {
  getDb,
  hasDatabaseContext,
  runInBypassContext,
  auditEventsTable,
  type AuditEvent,
} from "@workspace/db";
import { canonicalJson } from "../../lib/canonical-json";
import { auditLockWaitSeconds, auditLockFailures } from "../../lib/metrics";

const GENESIS = "0".repeat(64);
// Arbitrary stable lock id for serializing audit appends.
const AUDIT_LOCK_ID = 918273;

export interface AuditInput {
  actorId?: string | null;
  actorRole?: string | null;
  firmId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

function computeHash(
  prevHash: string,
  payload: Record<string, unknown>,
): string {
  return createHash("sha256")
    .update(prevHash + canonicalJson(payload))
    .digest("hex");
}

// Append a tamper-evident audit event. Serialized with a transaction-scoped
// advisory lock so concurrent appends cannot fork the chain (CORE-05).
export async function appendAudit(input: AuditInput): Promise<AuditEvent> {
  if (!hasDatabaseContext())
    return runInBypassContext(() => appendAudit(input));
  return getDb().transaction(async (tx) => {
    const stopWaiting = auditLockWaitSeconds.startTimer();
    try {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${AUDIT_LOCK_ID})`);
    } catch (error) {
      auditLockFailures.inc();
      throw error;
    } finally {
      stopWaiting();
    }
    const [last] = await tx
      .select({ hash: auditEventsTable.hash })
      .from(auditEventsTable)
      .orderBy(desc(auditEventsTable.seq))
      .limit(1);
    const prevHash = last?.hash ?? GENESIS;
    const createdAt = new Date();
    const payload = {
      actorId: input.actorId ?? null,
      actorRole: input.actorRole ?? null,
      firmId: input.firmId ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      before: input.before ?? null,
      after: input.after ?? null,
      createdAt: createdAt.toISOString(),
    };
    const hash = computeHash(prevHash, payload);
    const [row] = await tx
      .insert(auditEventsTable)
      .values({
        actorId: input.actorId ?? null,
        actorRole: input.actorRole ?? null,
        firmId: input.firmId ?? null,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        before: input.before ?? null,
        after: input.after ?? null,
        hash,
        prevHash,
        createdAt,
      })
      .returning();
    return row;
  });
}

export interface ChainVerification {
  valid: boolean;
  /** Events verified by this call (a window's worth, or the whole ledger). */
  count: number;
  brokenAtSeq: number | null;
  /** The last verified sequence — the `afterSeq` that starts the next window. */
  lastSeq: number | null;
  /** True when no events remain after lastSeq. */
  complete: boolean;
}

/** A window onto the ledger: events after `afterSeq`, at most `limit`. */
export interface ChainWindow {
  afterSeq?: number | undefined;
  limit?: number | undefined;
}

// Bounded reads (R98): the ledger is never loaded whole. A full verification
// walks it in VERIFY_BATCH-row batches carrying only the running hash, and
// every export is one window the caller pages with `afterSeq = lastSeq`.
const VERIFY_BATCH = 1_000;
const EXPORT_DEFAULT_LIMIT = 1_000;
const EXPORT_MAX_LIMIT = 5_000;
const LEDGER_CSV_CAP = 50_000;

function eventPayload(e: AuditEvent): Record<string, unknown> {
  return {
    actorId: e.actorId,
    actorRole: e.actorRole,
    firmId: e.firmId,
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId,
    before: e.before ?? null,
    after: e.after ?? null,
    createdAt: e.createdAt.toISOString(),
  };
}

// The hash a window chains from: the event at `afterSeq` (GENESIS when the
// window starts at the beginning). Null when that event no longer exists —
// a window that cannot be anchored is a broken chain, not a 404.
async function anchorHash(afterSeq: number): Promise<string | null> {
  if (afterSeq <= 0) return GENESIS;
  const [anchor] = await getDb()
    .select({ hash: auditEventsTable.hash })
    .from(auditEventsTable)
    .where(eq(auditEventsTable.seq, afterSeq))
    .limit(1);
  return anchor?.hash ?? null;
}

async function hasEventsAfter(seq: number): Promise<boolean> {
  const [next] = await getDb()
    .select({ seq: auditEventsTable.seq })
    .from(auditEventsTable)
    .where(gt(auditEventsTable.seq, seq))
    .limit(1);
  return !!next;
}

function verifyRows(
  events: AuditEvent[],
  prevHash: string,
): {
  checked: number;
  brokenAtSeq: number | null;
  lastHash: string;
  lastSeq: number | null;
} {
  let checked = 0;
  let lastSeq: number | null = null;
  for (const e of events) {
    const expected = computeHash(prevHash, eventPayload(e));
    if (e.prevHash !== prevHash || e.hash !== expected) {
      return { checked, brokenAtSeq: e.seq, lastHash: prevHash, lastSeq };
    }
    prevHash = e.hash;
    lastSeq = e.seq;
    checked++;
  }
  return { checked, brokenAtSeq: null, lastHash: prevHash, lastSeq };
}

// Recompute the chain and confirm no row was altered or removed. Without a
// window the whole ledger is walked in bounded batches; with one, only that
// window is verified and the result says where the next window starts.
export async function verifyChain(
  window: ChainWindow = {},
): Promise<ChainVerification> {
  const afterSeq = window.afterSeq ?? 0;
  let prevHash = await anchorHash(afterSeq);
  if (prevHash === null) {
    return {
      valid: false,
      count: 0,
      brokenAtSeq: afterSeq,
      lastSeq: null,
      complete: false,
    };
  }
  let remaining = window.limit ?? Number.POSITIVE_INFINITY;
  let cursor = afterSeq;
  let count = 0;
  let lastSeq: number | null = null;
  while (remaining > 0) {
    const take = Math.min(VERIFY_BATCH, remaining);
    const batch = await getDb()
      .select()
      .from(auditEventsTable)
      .where(gt(auditEventsTable.seq, cursor))
      .orderBy(asc(auditEventsTable.seq))
      .limit(take);
    if (batch.length === 0) break;
    const result = verifyRows(batch, prevHash);
    count += result.checked;
    if (result.lastSeq !== null) lastSeq = result.lastSeq;
    if (result.brokenAtSeq !== null) {
      return {
        valid: false,
        count,
        brokenAtSeq: result.brokenAtSeq,
        lastSeq,
        complete: false,
      };
    }
    prevHash = result.lastHash;
    cursor = batch[batch.length - 1]!.seq;
    remaining -= batch.length;
    if (batch.length < take) break;
  }
  const complete = remaining > 0 ? true : !(await hasEventsAfter(cursor));
  return { valid: true, count, brokenAtSeq: null, lastSeq, complete };
}

export interface AuditBundle {
  events: AuditEvent[];
  verification: ChainVerification;
  exportedAt: string;
  lastSeq: number | null;
  complete: boolean;
}

// One window of the exportable, verifiable bundle for a regulator, bank or
// acquirer (CORE-05): the events after `afterSeq` (at most `limit`) and the
// verification of exactly those rows, anchored on the event before them.
export async function exportAuditBundle(
  window: ChainWindow = {},
): Promise<AuditBundle> {
  const afterSeq = window.afterSeq ?? 0;
  const limit = Math.min(
    window.limit ?? EXPORT_DEFAULT_LIMIT,
    EXPORT_MAX_LIMIT,
  );
  const events = await getDb()
    .select()
    .from(auditEventsTable)
    .where(gt(auditEventsTable.seq, afterSeq))
    .orderBy(asc(auditEventsTable.seq))
    .limit(limit);
  const lastSeq = events.length ? events[events.length - 1]!.seq : null;
  const complete =
    events.length < limit || !(await hasEventsAfter(lastSeq ?? afterSeq));
  const anchor = await anchorHash(afterSeq);
  const verification: ChainVerification =
    anchor === null
      ? {
          valid: false,
          count: 0,
          brokenAtSeq: afterSeq,
          lastSeq: null,
          complete: false,
        }
      : (() => {
          const r = verifyRows(events, anchor);
          return {
            valid: r.brokenAtSeq === null,
            count: r.checked,
            brokenAtSeq: r.brokenAtSeq,
            lastSeq: r.lastSeq,
            complete: r.brokenAtSeq === null && complete,
          };
        })();
  return {
    events,
    verification,
    exportedAt: new Date().toISOString(),
    lastSeq,
    complete,
  };
}

export interface LedgerRow {
  seq: number;
  createdAt: Date;
  actorId: string | null;
  actorRole: string | null;
  firmId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  prevHash: string;
  hash: string;
}

// The spreadsheet ledger: the hash-bearing columns only (no payloads), at
// most LEDGER_CSV_CAP rows after `afterSeq`, with the chain verified over the
// same window in bounded batches.
export async function exportAuditLedger(afterSeq = 0): Promise<{
  rows: LedgerRow[];
  verification: ChainVerification;
  lastSeq: number | null;
  complete: boolean;
}> {
  const rows = await getDb()
    .select({
      seq: auditEventsTable.seq,
      createdAt: auditEventsTable.createdAt,
      actorId: auditEventsTable.actorId,
      actorRole: auditEventsTable.actorRole,
      firmId: auditEventsTable.firmId,
      action: auditEventsTable.action,
      entityType: auditEventsTable.entityType,
      entityId: auditEventsTable.entityId,
      prevHash: auditEventsTable.prevHash,
      hash: auditEventsTable.hash,
    })
    .from(auditEventsTable)
    .where(gt(auditEventsTable.seq, afterSeq))
    .orderBy(asc(auditEventsTable.seq))
    .limit(LEDGER_CSV_CAP);
  const lastSeq = rows.length ? rows[rows.length - 1]!.seq : null;
  const complete =
    rows.length < LEDGER_CSV_CAP ||
    !(await hasEventsAfter(lastSeq ?? afterSeq));
  const verification = await verifyChain({ afterSeq, limit: LEDGER_CSV_CAP });
  return { rows, verification, lastSeq, complete };
}
