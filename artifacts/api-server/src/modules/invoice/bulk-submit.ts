import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getDb, invoicesTable } from "@workspace/db";
import { appendAudit } from "../audit/audit";
import { DomainError } from "../errors";
import { isPurposePermitted } from "../consent/consent";
import { validateInvoice, submitInvoice } from "./service";
import type { FieldError } from "./canonical";

// Bulk validate & submit: the spreadsheet import lands hundreds of drafts in
// one call, but moving them onward was one invoice at a time. This loops the
// EXISTING per-invoice machinery — validateInvoice's compare-and-set
// transition and submitInvoice's exactly-once outbox enqueue (CON-01) — so
// every invoice gets the same lifecycle events, audit rows and idempotency
// guarantees as a single submit; the batch adds nothing but iteration.
//
// The batch is bounded (a request does a fixed amount of work, SEC-M3
// posture) and reports what remains, so the UI repeats until done. Rows that
// fail validation or hit a state race are REPORTED, not retried: the operator
// sees exactly which invoices need attention.

const MAX_BATCH = 200;

export interface BulkSubmitRowResult {
  invoiceId: string;
  invoiceNumber: string;
  outcome: "submitted" | "invalid" | "failed";
  errors: FieldError[];
  error: string | null;
}

export interface BulkSubmitResult {
  total: number;
  submittedCount: number;
  invalidCount: number;
  failedCount: number;
  remaining: number;
  rows: BulkSubmitRowResult[];
}

export async function bulkSubmit(
  clientPartyId: string,
  firmId: string | null,
  actorId: string,
  limit?: number,
): Promise<BulkSubmitResult> {
  // Consent gates every submission identically, so check once up front and
  // fail the whole batch the same way a single submit would (CORE-03) —
  // instead of producing 200 rows carrying the same refusal.
  if (!(await isPurposePermitted(clientPartyId, "compliance_submission"))) {
    throw new DomainError(
      "CONSENT_REQUIRED",
      "Supplier has not granted compliance (layer 1) consent",
      403,
    );
  }

  const batchSize = Math.min(Math.max(limit ?? MAX_BATCH, 1), MAX_BATCH);
  const conditions = [
    eq(invoicesTable.supplierPartyId, clientPartyId),
    inArray(invoicesTable.status, ["draft", "validated"]),
  ];
  if (firmId) conditions.push(eq(invoicesTable.firmId, firmId));

  const [{ pending }] = (
    await getDb()
      .select({ pending: sql<number>`count(*)::int` })
      .from(invoicesTable)
      .where(and(...conditions))
  ) as { pending: number }[];

  // Oldest first: the invoices waiting longest are closest to the submission
  // deadline (SME-05), so they go first when the batch is capped.
  const batch = await getDb()
    .select({
      id: invoicesTable.id,
      invoiceNumber: invoicesTable.invoiceNumber,
      status: invoicesTable.status,
    })
    .from(invoicesTable)
    .where(and(...conditions))
    .orderBy(asc(invoicesTable.createdAt))
    .limit(batchSize);

  const rows: BulkSubmitRowResult[] = [];
  for (const inv of batch) {
    const row: BulkSubmitRowResult = {
      invoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber,
      outcome: "submitted",
      errors: [],
      error: null,
    };
    try {
      if (inv.status === "draft") {
        const validation = await validateInvoice(inv.id, actorId);
        if (!validation.ok) {
          row.outcome = "invalid";
          row.errors = validation.errors;
          rows.push(row);
          continue;
        }
      }
      await submitInvoice(inv.id, actorId);
    } catch (err) {
      // A state race (another session moved the invoice) or any other
      // domain refusal marks THIS row failed; the batch keeps going.
      row.outcome = "failed";
      row.error =
        err instanceof DomainError
          ? err.message
          : "Submission failed unexpectedly";
    }
    rows.push(row);
  }

  const submittedCount = rows.filter((r) => r.outcome === "submitted").length;
  const invalidCount = rows.filter((r) => r.outcome === "invalid").length;
  const failedCount = rows.filter((r) => r.outcome === "failed").length;

  await appendAudit({
    actorId,
    firmId: firmId ?? undefined,
    action: "invoice.bulk_submit",
    entityType: "party",
    entityId: clientPartyId,
    after: {
      total: rows.length,
      submittedCount,
      invalidCount,
      failedCount,
      remaining: Math.max(0, pending - rows.length),
    },
  });

  return {
    total: rows.length,
    submittedCount,
    invalidCount,
    failedCount,
    remaining: Math.max(0, pending - rows.length),
    rows,
  };
}
