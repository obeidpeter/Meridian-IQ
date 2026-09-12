import { randomUUID } from "node:crypto";
import { and, eq, isNull, lt, lte, ne, or } from "drizzle-orm";
import {
  engagementsTable,
  evidenceEventsTable,
  evidenceFilesTable,
  evidenceRequestsTable,
  getDb,
  runInBypassContext,
  type EvidenceFile,
} from "@workspace/db";
import { isFeatureEnabled } from "../flags/flags";
import { lockEvidenceFirm } from "./commands";
import { evidenceScannerAvailable, scanEvidenceBytes } from "./clamav";
import { evidenceFileScope } from "./files";
import {
  decryptEvidence,
  evidenceHash,
  evidenceStorageAvailable,
} from "./security";

async function claimFile(): Promise<EvidenceFile | null> {
  return runInBypassContext(async () => {
    const now = new Date();
    const candidates = await getDb()
      .select({
        id: evidenceFilesTable.id,
        firmId: evidenceFilesTable.firmId,
        requestId: evidenceFilesTable.requestId,
        scanAttempts: evidenceFilesTable.scanAttempts,
      })
      .from(evidenceFilesTable)
      .where(
        and(
          eq(evidenceFilesTable.scanStatus, "quarantined"),
          lt(evidenceFilesTable.scanAttempts, 5),
          lte(evidenceFilesTable.nextScanAt, now),
          or(
            isNull(evidenceFilesTable.leaseUntil),
            lt(evidenceFilesTable.leaseUntil, now),
          ),
        ),
      )
      .orderBy(evidenceFilesTable.nextScanAt, evidenceFilesTable.id)
      .limit(10)
      .for("update", { skipLocked: true });
    for (const candidate of candidates) {
      const [request] = await getDb()
        .select()
        .from(evidenceRequestsTable)
        .where(eq(evidenceRequestsTable.id, candidate.requestId))
        .limit(1);
      const [engagement] = await getDb()
        .select({ id: engagementsTable.id })
        .from(engagementsTable)
        .where(
          and(
            eq(engagementsTable.firmId, candidate.firmId),
            eq(engagementsTable.clientPartyId, request.clientPartyId),
            ne(engagementsTable.status, "archived"),
          ),
        )
        .limit(1);
      if (
        !engagement ||
        !(await isFeatureEnabled("evidence_hub", candidate.firmId))
      ) {
        await getDb()
          .update(evidenceFilesTable)
          .set({ nextScanAt: new Date(Date.now() + 3600000) })
          .where(eq(evidenceFilesTable.id, candidate.id));
        continue;
      }
      const [claimed] = await getDb()
        .update(evidenceFilesTable)
        .set({
          scanToken: randomUUID(),
          leaseUntil: new Date(Date.now() + 30000),
          scanAttempts: candidate.scanAttempts + 1,
        })
        .where(eq(evidenceFilesTable.id, candidate.id))
        .returning();
      return claimed;
    }
    return null;
  });
}

async function completeScan(
  file: EvidenceFile,
  status: "clean" | "rejected" | "quarantined",
): Promise<void> {
  await runInBypassContext(async () => {
    await lockEvidenceFirm(file.firmId);
    const error =
      status === "rejected"
        ? "The security scan rejected this document. Upload a safe replacement."
        : status === "quarantined"
          ? "The security scan could not finish. The document remains quarantined."
          : null;
    const [updated] = await getDb()
      .update(evidenceFilesTable)
      .set({
        scanStatus: status,
        scanError: error,
        scannedAt: status === "quarantined" ? null : new Date(),
        scanToken: null,
        leaseUntil: null,
        nextScanAt: new Date(
          Date.now() + Math.min(60, 2 ** file.scanAttempts) * 60000,
        ),
      })
      .where(
        and(
          eq(evidenceFilesTable.id, file.id),
          eq(evidenceFilesTable.scanToken, file.scanToken!),
          eq(evidenceFilesTable.scanStatus, "quarantined"),
        ),
      )
      .returning({ id: evidenceFilesTable.id });
    if (!updated) return;
    await getDb()
      .insert(evidenceEventsTable)
      .values({
        firmId: file.firmId,
        requestId: file.requestId,
        fileId: file.id,
        actorId: null,
        action: `scan_${status}`,
        comment: error,
      });
  });
}

export async function sweepEvidenceScans(
  signal?: AbortSignal,
): Promise<number> {
  if (!evidenceScannerAvailable() || !evidenceStorageAvailable()) return 0;
  let count = 0;
  for (let index = 0; index < 3; index++) {
    signal?.throwIfAborted();
    const file = await claimFile();
    if (!file) break;
    let status: "clean" | "rejected" | "quarantined" = "quarantined";
    try {
      const bytes = decryptEvidence(
        file.encryptedContent,
        evidenceFileScope(file),
      );
      if (bytes.length === file.byteSize && evidenceHash(bytes) === file.sha256)
        status = await scanEvidenceBytes(bytes, signal);
    } catch {
      // A failed scan is never a clean result. Do not log content or scanner output.
    }
    // Persist a fenced retryable outcome before propagating graceful shutdown.
    await completeScan(file, signal?.aborted ? "quarantined" : status);
    signal?.throwIfAborted();
    count++;
  }
  return count;
}
