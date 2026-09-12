import { and, eq } from "drizzle-orm";
import { evidenceFilesTable, getDb } from "@workspace/db";
import type { Principal } from "../auth/rbac";
import { DomainError } from "../errors";
import { assertEvidenceRequest, evidenceIdentity } from "./access";
import { decryptEvidence, evidenceHash } from "./security";

export function evidenceFileScope(file: {
  firmId: string;
  requestId: string;
  id: string;
}): string {
  return `${file.firmId}:${file.requestId}:${file.id}`.toLowerCase();
}

export async function readEvidenceFile(principal: Principal, fileId: string) {
  const firmId = await evidenceIdentity(principal);
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
  const request = await assertEvidenceRequest(principal, pointer.requestId);
  const [file] = await getDb()
    .select()
    .from(evidenceFilesTable)
    .where(
      and(
        eq(evidenceFilesTable.id, fileId),
        eq(evidenceFilesTable.firmId, request.firmId),
      ),
    )
    .limit(1);
  if (!file || file.scanStatus !== "clean")
    throw new DomainError(
      "EVIDENCE_QUARANTINED",
      "This document has not passed its security scan and cannot be opened.",
      409,
    );
  const bytes = decryptEvidence(file.encryptedContent, evidenceFileScope(file));
  if (bytes.length !== file.byteSize || evidenceHash(bytes) !== file.sha256)
    throw new DomainError(
      "EVIDENCE_INTEGRITY_FAILED",
      "This document could not be read safely. Contact support.",
      503,
    );
  return { file, bytes, request };
}
