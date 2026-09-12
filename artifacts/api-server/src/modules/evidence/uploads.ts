import { randomUUID } from "node:crypto";
import { and, count, eq, sql } from "drizzle-orm";
import {
  evidenceFilesTable,
  evidenceRequestsTable,
  getDb,
  withTransaction,
} from "@workspace/db";
import type { Principal } from "../auth/rbac";
import { DomainError } from "../errors";
import { assertEvidenceRequest, evidenceIdentity } from "./access";
import {
  assertEvidenceVersion,
  assertReplay,
  commandHash,
  lockEvidenceFirm,
  recordEvidenceEvent,
  replayEvidenceEvent,
} from "./commands";
import { evidenceFileScope } from "./files";
import { normalizeEvidenceIds } from "./identifiers";
import { assertEvidencePdfSafe } from "./pdf-validation";
import {
  encryptEvidence,
  evidenceHash,
  MAX_EVIDENCE_VERSIONS,
  MAX_FIRM_EVIDENCE_BYTES,
  validateEvidenceUpload,
} from "./security";
import { evidenceDetail } from "./views";
import { syncEvidenceWork } from "./work-links";

export interface UploadEvidenceInput {
  clientRequestId: string;
  expectedVersion: number;
  filename: string;
  contentType: string;
  contentBase64: string;
}

async function assertStorageQuota(
  firmId: string,
  requestId: string,
  bytes: number,
): Promise<void> {
  const [versions] = await getDb()
    .select({ total: count() })
    .from(evidenceFilesTable)
    .where(eq(evidenceFilesTable.requestId, requestId));
  if (versions.total >= MAX_EVIDENCE_VERSIONS)
    throw new DomainError(
      "EVIDENCE_VERSION_LIMIT",
      "This request has reached its 20-version limit. Ask your accountant to create a new request.",
      409,
    );
  const [usage] = await getDb()
    .select({
      bytes: sql<number>`coalesce(sum(${evidenceFilesTable.byteSize}), 0)::bigint`,
    })
    .from(evidenceFilesTable)
    .where(eq(evidenceFilesTable.firmId, firmId));
  if (Number(usage.bytes) + bytes > MAX_FIRM_EVIDENCE_BYTES)
    throw new DomainError(
      "EVIDENCE_STORAGE_FULL",
      "This workspace has reached its document storage limit. Contact support.",
      409,
    );
}

export async function uploadEvidenceFile(
  principal: Principal,
  requestId: string,
  input: UploadEvidenceInput,
) {
  input = normalizeEvidenceIds(input);
  const bytes = validateEvidenceUpload(input);
  if (input.contentType === "application/pdf") {
    await evidenceIdentity(principal, "evidence.upload");
    await assertEvidenceRequest(principal, requestId);
    await assertEvidencePdfSafe(bytes);
  }
  const hash = commandHash({ ...input, contentBase64: evidenceHash(bytes) });
  return withTransaction(async () => {
    const firmId = await evidenceIdentity(principal, "evidence.upload");
    await lockEvidenceFirm(firmId);
    const request = await assertEvidenceRequest(principal, requestId, true);
    const [existing] = await getDb()
      .select({ requestHash: evidenceFilesTable.requestHash })
      .from(evidenceFilesTable)
      .where(
        and(
          eq(evidenceFilesTable.requestId, requestId),
          eq(evidenceFilesTable.clientRequestId, input.clientRequestId),
        ),
      )
      .limit(1);
    if (existing) {
      assertReplay(existing.requestHash, hash);
      return evidenceDetail(principal, requestId);
    }
    if (await replayEvidenceEvent(requestId, input.clientRequestId, hash))
      return evidenceDetail(principal, requestId);
    assertEvidenceVersion(request, input.expectedVersion);
    if (request.status === "accepted" || request.status === "cancelled")
      throw new DomainError(
        "EVIDENCE_CLOSED",
        "This request is closed. Ask your accountant to request changes before uploading again.",
        409,
      );
    await assertStorageQuota(firmId, requestId, bytes.length);
    const id = randomUUID();
    await getDb()
      .insert(evidenceFilesTable)
      .values({
        id,
        firmId,
        requestId,
        filename: input.filename,
        contentType: input.contentType,
        byteSize: bytes.length,
        sha256: evidenceHash(bytes),
        encryptedContent: encryptEvidence(
          bytes,
          evidenceFileScope({
            id,
            firmId: request.firmId,
            requestId: request.id,
          }),
        ),
        uploadedBy: principal.userId,
        clientRequestId: input.clientRequestId,
        requestHash: hash,
      });
    const [updated] = await getDb()
      .update(evidenceRequestsTable)
      .set({
        status: "uploaded",
        latestFileId: id,
        acceptedFileId: null,
        version: request.version + 1,
        updatedAt: new Date(),
        lastReminderAt: null,
      })
      .where(eq(evidenceRequestsTable.id, requestId))
      .returning();
    await syncEvidenceWork(updated);
    await recordEvidenceEvent(principal, updated, {
      action: "uploaded",
      fileId: id,
      clientRequestId: input.clientRequestId,
      requestHash: hash,
    });
    return evidenceDetail(principal, requestId);
  });
}
