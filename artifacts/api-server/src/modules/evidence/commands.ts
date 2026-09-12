import { and, eq, sql } from "drizzle-orm";
import {
  evidenceEventsTable,
  getDb,
  type EvidenceRequest,
} from "@workspace/db";
import { canonicalJson } from "../../lib/canonical-json";
import type { Principal } from "../auth/rbac";
import { appendAudit } from "../audit/audit";
import { DomainError } from "../errors";
import { evidenceHash } from "./security";
import { notifyEvidenceTransition } from "./work-links";

export async function lockEvidenceFirm(firmId: string): Promise<void> {
  await getDb().execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`evidence:${firmId}`}, 0))`,
  );
}

export function commandHash(value: unknown): string {
  return evidenceHash(canonicalJson(value));
}

export function assertReplay(storedHash: string | null, hash: string): void {
  if (storedHash !== hash)
    throw new DomainError(
      "EVIDENCE_REQUEST_REUSED",
      "This action was already used for different content. Refresh and try again.",
      409,
    );
}

export function assertEvidenceVersion(
  request: EvidenceRequest,
  expectedVersion: number,
): void {
  if (request.version !== expectedVersion)
    throw new DomainError(
      "EVIDENCE_VERSION_CONFLICT",
      "Someone changed this request. Refresh it before continuing.",
      409,
    );
}

export async function replayEvidenceEvent(
  requestId: string,
  clientRequestId: string,
  hash: string,
): Promise<boolean> {
  const [event] = await getDb()
    .select({ requestHash: evidenceEventsTable.requestHash })
    .from(evidenceEventsTable)
    .where(
      and(
        eq(evidenceEventsTable.requestId, requestId),
        eq(evidenceEventsTable.clientRequestId, clientRequestId),
      ),
    )
    .limit(1);
  if (!event) return false;
  assertReplay(event.requestHash, hash);
  return true;
}

export async function recordEvidenceEvent(
  principal: Principal,
  request: EvidenceRequest,
  input: {
    action: string;
    fileId?: string | null;
    comment?: string | null;
    clientRequestId: string;
    requestHash: string;
  },
): Promise<void> {
  const [event] = await getDb()
    .insert(evidenceEventsTable)
    .values({
      firmId: request.firmId,
      requestId: request.id,
      actorId: principal.userId,
      ...input,
    })
    .returning();
  await notifyEvidenceTransition(request, event);
  await appendAudit({
    actorId: principal.userId,
    actorRole: principal.role,
    firmId: request.firmId,
    action: `evidence.${input.action}`,
    entityType: "evidence_request",
    entityId: request.id,
    after: {
      version: request.version,
      status: request.status,
      fileId: input.fileId ?? null,
      ownerId: request.ownerId,
      dueAt: request.dueAt?.toISOString() ?? null,
    },
  });
}
