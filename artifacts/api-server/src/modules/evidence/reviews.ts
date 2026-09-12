import { and, eq } from "drizzle-orm";
import {
  evidenceFilesTable,
  evidenceRequestsTable,
  getDb,
  withTransaction,
  type EvidenceRequest,
} from "@workspace/db";
import type { Principal } from "../auth/rbac";
import { DomainError } from "../errors";
import { assertEvidenceRequest, evidenceIdentity } from "./access";
import {
  assertEvidenceVersion,
  commandHash,
  lockEvidenceFirm,
  recordEvidenceEvent,
  replayEvidenceEvent,
} from "./commands";
import { evidenceDetail } from "./views";
import { normalizeEvidenceIds } from "./identifiers";
import { syncEvidenceWork } from "./work-links";

export interface ReviewEvidenceInput {
  clientRequestId: string;
  expectedVersion: number;
  fileId?: string;
  decision: "accepted" | "needs_changes" | "cancelled";
  comment?: string;
}

async function assertReview(
  request: EvidenceRequest,
  input: ReviewEvidenceInput,
): Promise<void> {
  if (request.status === "cancelled")
    throw new DomainError(
      "EVIDENCE_CLOSED",
      "This request has been cancelled. Create a new request if needed.",
      409,
    );
  if (input.decision !== "accepted" && !input.comment?.trim())
    throw new DomainError(
      "EVIDENCE_COMMENT_REQUIRED",
      "Explain what needs to change or why this request is being cancelled.",
      400,
    );
  if (input.fileId && input.fileId !== request.latestFileId)
    throw new DomainError(
      "EVIDENCE_FILE_CHANGED",
      "Review the latest document before continuing.",
      409,
    );
  if (input.decision !== "accepted") return;
  if (
    !input.fileId ||
    input.fileId !== request.latestFileId ||
    request.status !== "uploaded"
  )
    throw new DomainError(
      "EVIDENCE_FILE_CHANGED",
      "Review the latest uploaded document before accepting it.",
      409,
    );
  const [file] = await getDb()
    .select({ scanStatus: evidenceFilesTable.scanStatus })
    .from(evidenceFilesTable)
    .where(
      and(
        eq(evidenceFilesTable.id, input.fileId),
        eq(evidenceFilesTable.requestId, request.id),
      ),
    )
    .limit(1);
  if (file?.scanStatus !== "clean")
    throw new DomainError(
      "EVIDENCE_QUARANTINED",
      "The document must pass its security scan before it can be accepted.",
      409,
    );
}

export async function reviewEvidenceRequest(
  principal: Principal,
  requestId: string,
  input: ReviewEvidenceInput,
) {
  input = normalizeEvidenceIds(input);
  return withTransaction(async () => {
    const firmId = await evidenceIdentity(principal, "evidence.review");
    await lockEvidenceFirm(firmId);
    const request = await assertEvidenceRequest(principal, requestId, true);
    const hash = commandHash(input);
    if (await replayEvidenceEvent(requestId, input.clientRequestId, hash))
      return evidenceDetail(principal, requestId);
    assertEvidenceVersion(request, input.expectedVersion);
    await assertReview(request, input);
    const [updated] = await getDb()
      .update(evidenceRequestsTable)
      .set({
        status: input.decision,
        acceptedFileId: input.decision === "accepted" ? input.fileId : null,
        version: request.version + 1,
        updatedAt: new Date(),
        lastReminderAt: null,
      })
      .where(eq(evidenceRequestsTable.id, requestId))
      .returning();
    await syncEvidenceWork(updated);
    await recordEvidenceEvent(principal, updated, {
      action: input.decision,
      fileId: input.fileId ?? request.latestFileId,
      comment: input.comment?.trim() || null,
      clientRequestId: input.clientRequestId,
      requestHash: hash,
    });
    return evidenceDetail(principal, requestId);
  });
}
