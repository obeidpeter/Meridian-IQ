import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getDb, invoicesTable, runRequestContext } from "@workspace/db";
import { appendAudit } from "../audit/audit";
import { DomainError } from "../errors";
import { isPurposePermitted } from "../consent/consent";
import { validateInvoice, submitInvoice } from "./service";
import { firmSubmitApprovalRequired } from "./approvals";
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
//
// Transaction shape (posture round — the last batch surface to convert):
// the route runs OUTSIDE the request transaction (app.ts NO_CONTEXT_ROUTES)
// and every stage below commits in its own short runRequestContext
// transaction bound to the CALLER's posture — the bulk-approve /
// proposed-actions discipline. Inside one request transaction, the first
// row's appendAudit held the GLOBAL audit advisory lock until the whole
// 200-row batch committed: a platform-wide appendAudit convoy plus a real
// deadlock window against the row-lock→audit-lock order of concurrent
// single submits (the app.ts NO_CONTEXT comments' documented class). The
// trade is the sibling batches': a submitted row is durable IMMEDIATELY —
// nothing later in the batch (or a response failure) can undo it, exactly
// as if the operator had clicked the 200 single submits by hand. The
// honest crash window: a crash mid-batch leaves the completed rows
// submitted with their per-invoice lifecycle/audit events but NO
// invoice.bulk_submit summary event. Per-row validate and submit each
// commit separately, so a draft that validates and then fails submission
// stays VALIDATED (today's observable behavior, preserved). Two more
// deltas vs the buffered transaction: a client disconnect mid-batch no
// longer aborts the run (the old close-handler rollback) — the batch
// completes and commits with nobody reading the response, and a re-run
// self-heals because submitted rows leave the pending scan; and the 30s
// request-transaction cap no longer applies — a full 200-row batch is
// EXPECTED to outrun it, which is half the reason to leave.

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
  // The caller's own tenancy posture, re-bound per stage: firm principals
  // get their firm GUC (RLS exactly as their request transaction carried);
  // cross-tenant staff — firmId null, which is precisely how the route
  // derives it via tenantFirmId — get bypass, matching theirs. Passing
  // null is an ACTIVE grant of platform-wide bypass (the old in-transaction
  // module merely inherited ambient posture): only a caller that verified a
  // cross-tenant principal may do it. Unreachable via HTTP today —
  // invoice.submit is held by firm-bound roles only — so the arm exists
  // for posture completeness and direct callers.
  const ctx = <T>(fn: () => Promise<T>): Promise<T> =>
    firmId
      ? runRequestContext({ bypass: false, firmId }, fn)
      : runRequestContext({ bypass: true, firmId: null }, fn);

  const batchSize = Math.min(Math.max(limit ?? MAX_BATCH, 1), MAX_BATCH);
  const conditions = [
    eq(invoicesTable.supplierPartyId, clientPartyId),
    inArray(invoicesTable.status, ["draft", "validated"]),
  ];
  if (firmId) conditions.push(eq(invoicesTable.firmId, firmId));

  // Stage A — gates, the honest pending count and the candidate batch, one
  // short read-mostly transaction.
  const staged = await ctx(async () => {
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

    // Maker-checker policy state, read ONCE up front like the consent check —
    // but NOT enforced here: enforcement stays per-row inside submitInvoice
    // (assertSubmitApproved), where a row lacking a colleague's live approval
    // surfaces as outcome "failed" carrying the APPROVAL_REQUIRED message. The
    // hoisted read only annotates the batch audit so an all-failed batch is
    // explicable at a glance. Cross-tenant callers (firmId null) have no single
    // policy to note; each invoice's own firm policy still applies per row.
    const submitApprovalRequired = firmId
      ? await firmSubmitApprovalRequired(firmId)
      : null;

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

    return { submitApprovalRequired, pending, batch };
  });
  const { submitApprovalRequired, pending } = staged;

  const rows: BulkSubmitRowResult[] = [];
  for (const inv of staged.batch) {
    const row: BulkSubmitRowResult = {
      invoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber,
      outcome: "submitted",
      errors: [],
      error: null,
    };
    // Validate and submit each commit in their OWN short transaction —
    // exactly what two sequential single-route calls would do, so a draft
    // that validates and then fails submission stays validated, the global
    // audit lock is held per call only, and a submitted row is durable
    // immediately.
    try {
      if (inv.status === "draft") {
        const validation = await ctx(() => validateInvoice(inv.id, actorId));
        if (!validation.ok) {
          row.outcome = "invalid";
          row.errors = validation.errors;
          rows.push(row);
          continue;
        }
      }
      await ctx(() => submitInvoice(inv.id, actorId));
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

  // Stage Z — the batch summary event, its own short transaction (each row
  // already appended its per-invoice lifecycle/audit events as it ran).
  await ctx(() =>
    appendAudit({
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
        submitApprovalRequired,
      },
    }),
  );

  return {
    total: rows.length,
    submittedCount,
    invalidCount,
    failedCount,
    remaining: Math.max(0, pending - rows.length),
    rows,
  };
}
