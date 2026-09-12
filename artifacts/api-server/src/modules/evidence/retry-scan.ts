import { and, eq } from "drizzle-orm";
import { evidenceFilesTable, getDb, withTransaction } from "@workspace/db";
import type { Principal } from "../auth/rbac";
import { DomainError } from "../errors";
import { assertEvidenceRequest, evidenceIdentity } from "./access";
import {
  commandHash,
  lockEvidenceFirm,
  recordEvidenceEvent,
  replayEvidenceEvent,
} from "./commands";
import { evidenceScannerAvailable } from "./clamav";
import { evidenceDetail } from "./views";

export async function retryEvidenceScan(
  principal: Principal,
  fileId: string,
  clientRequestId: string,
) {
  fileId = fileId.toLowerCase();
  clientRequestId = clientRequestId.toLowerCase();
  return withTransaction(async () => {
    const firmId = await evidenceIdentity(principal, "evidence.review");
    await lockEvidenceFirm(firmId);
    const [pointer] = await getDb()
      .select({ requestId: evidenceFilesTable.requestId })
      .from(evidenceFilesTable)
      .where(
        and(
          eq(evidenceFilesTable.id, fileId),
          eq(evidenceFilesTable.firmId, firmId),
        ),
      )
      .limit(1);
    if (!pointer)
      throw new DomainError(
        "EVIDENCE_NOT_FOUND",
        "This document could not be found.",
        404,
      );
    const request = await assertEvidenceRequest(
      principal,
      pointer.requestId,
      true,
    );
    const hash = commandHash({ action: "retry_scan", fileId, clientRequestId });
    if (await replayEvidenceEvent(request.id, clientRequestId, hash))
      return evidenceDetail(principal, request.id);
    const [file] = await getDb()
      .select()
      .from(evidenceFilesTable)
      .where(eq(evidenceFilesTable.id, fileId))
      .for("update");
    if (file.scanStatus === "clean" || request.acceptedFileId === fileId)
      throw new DomainError(
        "EVIDENCE_ALREADY_SCANNED",
        "This document has already passed its security scan.",
        409,
      );
    if (!evidenceScannerAvailable())
      throw new DomainError(
        "EVIDENCE_SCAN_UNAVAILABLE",
        "The security scanner is not configured. Contact your administrator.",
        503,
      );
    if (file.leaseUntil && file.leaseUntil > new Date())
      throw new DomainError(
        "EVIDENCE_SCAN_IN_PROGRESS",
        "This document is already being scanned. Check again shortly.",
        409,
      );
    if (
      file.scanStatus === "quarantined" &&
      !file.scanError &&
      file.scanAttempts < 5
    )
      throw new DomainError(
        "EVIDENCE_SCAN_IN_PROGRESS",
        "This document is already waiting for a security scan.",
        409,
      );
    await getDb()
      .update(evidenceFilesTable)
      .set({
        scanStatus: "quarantined",
        scanError: null,
        scanAttempts: 0,
        scanToken: null,
        leaseUntil: null,
        nextScanAt: new Date(),
        scannedAt: null,
      })
      .where(eq(evidenceFilesTable.id, fileId));
    await recordEvidenceEvent(principal, request, {
      action: "scan_requested",
      fileId,
      clientRequestId,
      requestHash: hash,
    });
    return evidenceDetail(principal, request.id);
  });
}
