import { and, desc, eq, sql } from "drizzle-orm";
import {
  getDb,
  matchProposalsTable,
  bankStatementLinesTable,
} from "@workspace/db";
import { appendAudit } from "../audit/audit";
import { DomainError } from "../errors";
import { acceptProposal } from "./service";

// Bulk-accept for high-confidence reconciliation matches. The matcher emits
// deterministic confidences (SME-07); everything at or above the threshold is
// accepted through the EXISTING acceptProposal path — one settlement event,
// one lifecycle transition, one audit row per proposal, identical to a manual
// click — so the batch turns a 40-line statement into one action plus the
// genuinely ambiguous leftovers.
//
// Only the best proposal per statement line enters the batch (accepting one
// supersedes its siblings; feeding those in would just manufacture failure
// rows). A proposal that fails mid-batch — e.g. its invoice was already
// settled by an earlier line in this same batch — is reported, not retried.

export const DEFAULT_BULK_ACCEPT_THRESHOLD = 0.85;
const MAX_BATCH = 500;

export interface BulkAcceptRow {
  proposalId: string;
  invoiceId: string;
  confidence: string;
  outcome: "accepted" | "failed";
  error: string | null;
}

export interface BulkAcceptOutcome {
  total: number;
  acceptedCount: number;
  failedCount: number;
  rows: BulkAcceptRow[];
}

export async function bulkAcceptProposals(
  statementId: string,
  actor: { userId: string; role: string },
  threshold = DEFAULT_BULK_ACCEPT_THRESHOLD,
): Promise<BulkAcceptOutcome> {
  const candidates = await getDb()
    .select({
      id: matchProposalsTable.id,
      invoiceId: matchProposalsTable.invoiceId,
      confidence: matchProposalsTable.confidence,
      statementLineId: matchProposalsTable.statementLineId,
    })
    .from(matchProposalsTable)
    .innerJoin(
      bankStatementLinesTable,
      eq(matchProposalsTable.statementLineId, bankStatementLinesTable.id),
    )
    .where(
      and(
        eq(bankStatementLinesTable.statementId, statementId),
        eq(matchProposalsTable.status, "proposed"),
        sql`${matchProposalsTable.confidence} >= ${threshold}`,
      ),
    )
    .orderBy(desc(matchProposalsTable.confidence))
    .limit(MAX_BATCH);

  // Best proposal per line only (candidates arrive confidence-descending).
  const seenLines = new Set<string>();
  const batch = candidates.filter((c) => {
    if (seenLines.has(c.statementLineId)) return false;
    seenLines.add(c.statementLineId);
    return true;
  });

  const rows: BulkAcceptRow[] = [];
  for (const c of batch) {
    try {
      await acceptProposal(c.id, actor);
      rows.push({
        proposalId: c.id,
        invoiceId: c.invoiceId,
        confidence: c.confidence,
        outcome: "accepted",
        error: null,
      });
    } catch (err) {
      rows.push({
        proposalId: c.id,
        invoiceId: c.invoiceId,
        confidence: c.confidence,
        outcome: "failed",
        error:
          err instanceof DomainError
            ? err.message
            : "Acceptance failed unexpectedly",
      });
    }
  }

  const acceptedCount = rows.filter((r) => r.outcome === "accepted").length;
  const failedCount = rows.length - acceptedCount;
  await appendAudit({
    actorId: actor.userId,
    action: "reconciliation.bulk_accept",
    entityType: "bank_statement",
    entityId: statementId,
    after: { threshold, total: rows.length, acceptedCount, failedCount },
  });

  return { total: rows.length, acceptedCount, failedCount, rows };
}
