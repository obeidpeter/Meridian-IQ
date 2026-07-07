import { createHash } from "node:crypto";
import { asc, desc, sql } from "drizzle-orm";
import { getDb, auditEventsTable, type AuditEvent } from "@workspace/db";
import { canonicalJson } from "../../lib/canonical-json";

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

function computeHash(prevHash: string, payload: Record<string, unknown>): string {
  return createHash("sha256")
    .update(prevHash + canonicalJson(payload))
    .digest("hex");
}

// Append a tamper-evident audit event. Serialized with a transaction-scoped
// advisory lock so concurrent appends cannot fork the chain (CORE-05).
export async function appendAudit(input: AuditInput): Promise<AuditEvent> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${AUDIT_LOCK_ID})`);
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
  count: number;
  brokenAtSeq: number | null;
}

// Recompute the whole chain and confirm no row was altered or removed.
export async function verifyChain(): Promise<ChainVerification> {
  const events = await getDb()
    .select()
    .from(auditEventsTable)
    .orderBy(asc(auditEventsTable.seq));
  let prevHash = GENESIS;
  for (const e of events) {
    const payload = {
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
    const expected = computeHash(prevHash, payload);
    if (e.prevHash !== prevHash || e.hash !== expected) {
      return { valid: false, count: events.length, brokenAtSeq: e.seq };
    }
    prevHash = e.hash;
  }
  return { valid: true, count: events.length, brokenAtSeq: null };
}

// Exportable, verifiable bundle for a regulator, bank or acquirer (CORE-05).
export async function exportAuditBundle(): Promise<{
  events: AuditEvent[];
  verification: ChainVerification;
  exportedAt: string;
}> {
  const events = await getDb()
    .select()
    .from(auditEventsTable)
    .orderBy(asc(auditEventsTable.seq));
  const verification = await verifyChain();
  return { events, verification, exportedAt: new Date().toISOString() };
}
