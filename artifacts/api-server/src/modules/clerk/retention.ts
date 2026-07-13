import { sql } from "drizzle-orm";
import { getDb, clerkCasesTable } from "@workspace/db";
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

  const rows = await getDb()
    .update(clerkCasesTable)
    .set({ sourceText: null, sourceImageB64: null })
    .where(
      sql`${clerkCasesTable.status} IN ('approved', 'rejected', 'failed')
        AND ${clerkCasesTable.updatedAt} < now() - make_interval(days => ${days})
        AND (${clerkCasesTable.sourceText} IS NOT NULL
          OR ${clerkCasesTable.sourceImageB64} IS NOT NULL)`,
    )
    .returning({ id: clerkCasesTable.id, status: clerkCasesTable.status });

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
  return rows.length;
}
