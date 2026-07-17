import { sql } from "drizzle-orm";
import { getDb, clerkBatchesTable } from "@workspace/db";
import { appendAudit } from "../audit/audit";

// Content retention sweep (OPEN-8 minimisation posture). Raw uploaded invoice
// content — document text, transcripts, base64 images — is C3 material that
// only exists to let the operator verify the extraction. Once a case reaches
// a state where nobody will look at the source again, keeping it is pure
// blast radius. N days after the last write, the sweep nulls the raw content
// while keeping everything evidential: sourceHash (duplicate guard still
// works), extraction, corrections, decision trail and the inference ledger.
//
// Which states qualify:
//   approved / rejected — terminal; the decision is recorded, the draft
//     invoice (if any) is the canonical artifact.
//   failed — retryable in principle, but a case nobody retried for N days is
//     abandoned; retry on a purged case already fails safe (CASE_NO_SOURCE).
//   escalated / extracted / in_review — live work queue; NEVER purged, the
//     operator still needs to see the document.
//
// Voice intake already takes this stance at capture time (audio is never
// persisted); this extends it to the rest of the lifecycle.

export async function sweepExpiredCaseContent(): Promise<number> {
  const days = Number(process.env.CLERK_CONTENT_RETENTION_DAYS ?? 30);
  if (!Number.isFinite(days) || days < 1) return 0;

  // Raw SQL, deliberately NOT the ORM update: drizzle's $onUpdate would bump
  // updated_at to the purge time, and updated_at IS the decision timestamp
  // for a decided case — metrics.avgDecisionMinutes and the adoption
  // report's review-turnaround both read it. A purge is housekeeping, not a
  // decision; it must leave the decision clock untouched. (Re-matching is
  // impossible afterwards because the content columns are NULL.)
  const rows = (
    await getDb().execute<{ id: string; status: string }>(sql`
      UPDATE clerk_cases
      SET source_text = NULL,
          source_image_b64 = NULL,
          source_scan_pages_b64 = NULL
      WHERE status IN ('approved', 'rejected', 'failed')
        AND updated_at < now() - make_interval(days => ${days})
        AND (source_text IS NOT NULL
          OR source_image_b64 IS NOT NULL
          OR source_scan_pages_b64 IS NOT NULL)
      RETURNING id, status
    `)
  ).rows;

  for (const row of rows) {
    await appendAudit({
      actorId: "clerk-sweep",
      actorRole: "system",
      action: "clerk.case.content_purged",
      entityType: "clerk_case",
      entityId: row.id,
      after: {
        status: row.status,
        retentionDays: days,
        retained: ["sourceHash", "extraction", "corrections", "ledger"],
      },
    });
  }

  // Async batches (idea #8) hold the same C3 material in sourceText/segments.
  // Terminal batches clear it inline; this backstop catches batches that
  // NEVER reach a terminal state — kill switch left off, no provider
  // configured — so a queued bundle cannot hold client document content
  // indefinitely. The batch is failed (visibly, with a reason) and purged.
  const staleBatches = await getDb()
    .update(clerkBatchesTable)
    .set({
      status: "failed",
      failReason:
        "The bundle sat unprocessed past the retention window and its content was purged. Upload it again when Clerk is available.",
      sourceText: null,
      segments: null,
      sourcePdfB64: null,
      scanSegments: null,
    })
    .where(
      sql`${clerkBatchesTable.status} IN ('queued', 'processing')
        AND ${clerkBatchesTable.updatedAt} < now() - make_interval(days => ${days})
        AND (${clerkBatchesTable.sourceText} IS NOT NULL
          OR ${clerkBatchesTable.segments} IS NOT NULL
          OR ${clerkBatchesTable.sourcePdfB64} IS NOT NULL
          OR ${clerkBatchesTable.scanSegments} IS NOT NULL)`,
    )
    .returning({ id: clerkBatchesTable.id });
  for (const row of staleBatches) {
    await appendAudit({
      actorId: "clerk-sweep",
      actorRole: "system",
      action: "clerk.batch.content_purged",
      entityType: "clerk_batch",
      entityId: row.id,
      after: { retentionDays: days },
    });
  }

  return rows.length + staleBatches.length;
}
