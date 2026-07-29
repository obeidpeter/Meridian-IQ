import { Router, type IRouter } from "express";
import { getDb, outboxTable, runRequestContext } from "@workspace/db";
import {
  RecordChaseReminderParams,
  RecordChaseReminderResponse,
  BulkSubmitInvoicesBody,
  BulkSubmitInvoicesResponse,
  GetInvoiceParams,
  GetInvoiceResponse,
  UpdateInvoiceParams,
  UpdateInvoiceBody,
  UpdateInvoiceResponse,
  ValidateInvoiceParams,
  ValidateInvoiceResponse,
  SubmitInvoiceParams,
  SubmitInvoiceResponse,
  ApproveInvoiceParams,
  ApproveInvoiceBody,
  ApproveInvoiceResponse,
  ListInvoiceApprovalsParams,
  ListInvoiceApprovalsResponse,
  CancelInvoiceParams,
  CancelInvoiceBody,
  CancelInvoiceResponse,
  CreditNoteInvoiceParams,
  CreditNoteInvoiceBody,
  CreditNoteInvoiceResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../../lib/parse";
import {
  assertCan,
  assertPartyAccess,
  tenantFirmId,
} from "../../modules/auth/rbac";
import { bulkSubmit } from "../../modules/invoice/bulk-submit";
import { recordChase } from "../../modules/invoice/chase-log";
import {
  assertReceivableOriented,
  createDraft,
  validateInvoice,
  submitInvoice,
  updateInvoiceContent,
} from "../../modules/invoice/service";
import {
  approvalViews,
  listApprovals,
  recordApproval,
} from "../../modules/invoice/approvals";
import {
  canTransition,
  applyTransition,
  recordTransition,
} from "../../modules/invoice/lifecycle";
import { appendAudit } from "../../modules/audit/audit";
import { DomainError } from "../../modules/errors";
import { loadForTenant } from "./shared";

// The invoice lifecycle: read/fix a single invoice and move it onward —
// validate, submit (single and bulk), maker-checker approval, cancel and
// credit-note. The literal /invoices/bulk-submit registers BEFORE the
// /invoices/:id family in this file, and index.ts mounts this group in the
// original order, so a :id route can never swallow it.

const router: IRouter = Router();

// Chase ladder (round-14 idea #3): record that a payment reminder was SENT —
// the UI logs on copy, never on draft. The module enforces the same
// tenant + SEC-03 + still-outstanding gates as the chaser draft itself.
router.post(
  "/invoices/:invoiceId/chase-log",
  async (req, res): Promise<void> => {
    assertCan(req.principal, "invoice.write");
    const params = parseOrThrow(RecordChaseReminderParams, req.params);
    const summary = await recordChase(params.invoiceId, req.principal);
    res.status(201).json(RecordChaseReminderResponse.parse(summary));
  },
);

// Bulk validate & submit: same capability, party-access and consent gates as
// a single submit — the batch only adds iteration. Selection is server-side
// (the client's pending drafts, oldest first) so a paginated UI doesn't have
// to know every draft id. Runs OUTSIDE the request transaction (app.ts
// NO_CONTEXT_ROUTES — the posture round): the module commits every stage in
// its own short caller-bound transaction, so the party-access lookup here
// gets its own context too (the raw pool has no GUCs — RLS would blank the
// engagement read and false-deny).
router.post("/invoices/bulk-submit", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.submit");
  const body = parseOrThrow(BulkSubmitInvoicesBody, req.body);
  const tenant = tenantFirmId(req.principal);
  await runRequestContext(
    tenant ? { bypass: false, firmId: tenant } : { bypass: true, firmId: null },
    () => assertPartyAccess(req.principal, body.clientPartyId),
  );
  const result = await bulkSubmit(
    body.clientPartyId,
    tenant,
    req.principal.userId,
    body.limit,
  );
  res.json(BulkSubmitInvoicesResponse.parse(result));
});

router.get("/invoices/:id", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const params = parseOrThrow(GetInvoiceParams, req.params);
  const bundle = await loadForTenant(req, params.id);
  res.json(GetInvoiceResponse.parse(bundle));
});

// Fix-and-retry: correct the content of an invoice that is still mutable per
// the lifecycle (draft, validated, failed). The service is the authority —
// assertMutableContent 409s for submitted/stamped/terminal invoices, and a
// validated invoice reverts to draft so stale validation cannot be submitted.
router.patch("/invoices/:id", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.write");
  const params = parseOrThrow(UpdateInvoiceParams, req.params);
  const body = parseOrThrow(UpdateInvoiceBody, req.body);
  await loadForTenant(req, params.id);
  const bundle = await updateInvoiceContent(
    params.id,
    body,
    req.principal.userId,
  );
  res.json(UpdateInvoiceResponse.parse(bundle));
});

router.post("/invoices/:id/validate", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.write");
  const params = parseOrThrow(ValidateInvoiceParams, req.params);
  await loadForTenant(req, params.id);
  const result = await validateInvoice(params.id, req.principal.userId);
  res.json(ValidateInvoiceResponse.parse(result));
});

router.post("/invoices/:id/submit", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.submit");
  const params = parseOrThrow(SubmitInvoiceParams, req.params);
  await loadForTenant(req, params.id);
  const invoice = await submitInvoice(params.id, req.principal.userId);
  res.status(202).json(SubmitInvoiceResponse.parse(invoice));
});

// Maker-checker (contract 0.45.0): record a submission approval. The module
// guards orientation (a bill 409s NOT_SUBMITTABLE) and state (pre-submission
// paper only); the approver/submitter separation bites at submit time, where
// the firm's policy demands a live approval by someone OTHER than the
// submitter. Body is optional (an approval needs no note).
router.post("/invoices/:id/approve", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.approve");
  const params = parseOrThrow(ApproveInvoiceParams, req.params);
  const { invoice } = await loadForTenant(req, params.id);
  const body = parseOrThrow(ApproveInvoiceBody, req.body ?? {});
  const row = await recordApproval(invoice, req.principal.userId, body.note);
  const [view] = await approvalViews([row]);
  res.status(201).json(ApproveInvoiceResponse.parse(view));
});

// The invoice's approval evidence trail, newest first, revoked rows included.
// Same gate and scoping as GET /invoices/:id (tenant + SEC-03 via
// loadForTenant).
router.get("/invoices/:id/approvals", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const params = parseOrThrow(ListInvoiceApprovalsParams, req.params);
  await loadForTenant(req, params.id);
  res.json(ListInvoiceApprovalsResponse.parse(await listApprovals(params.id)));
});

router.post("/invoices/:id/cancel", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.write");
  const params = parseOrThrow(CancelInvoiceParams, req.params);
  // CORE-09: cancellation is a first-class lifecycle event and always carries a
  // stated reason.
  const body = parseOrThrow(CancelInvoiceBody, req.body);
  const { invoice } = await loadForTenant(req, params.id);
  // Compare-and-set: a concurrent transition (e.g. the worker crediting this
  // invoice) rejects the cancel instead of being overwritten.
  const row = await applyTransition(invoice.id, invoice.status, "cancelled");
  await recordTransition({
    invoiceId: invoice.id,
    firmId: invoice.firmId,
    fromStatus: invoice.status,
    toStatus: "cancelled",
    actorId: req.principal.userId,
    actorRole: req.principal.role,
    reason: body.reason,
  });
  await appendAudit({
    actorId: req.principal.userId,
    firmId: invoice.firmId,
    action: "invoice.cancel",
    entityType: "invoice",
    entityId: invoice.id,
    before: { status: invoice.status },
    after: { status: "cancelled", reason: body.reason },
  });
  // A post-stamp cancellation propagates: reconciliation proposals close and the
  // verification cache is staled so the invoice can never present as eligible.
  if (invoice.status !== "draft" && invoice.status !== "validated") {
    await getDb().insert(outboxTable).values({
      aggregateType: "invoice",
      aggregateId: invoice.id,
      type: "invoice.lifecycle_changed",
      payload: { invoiceId: invoice.id, toStatus: "cancelled" },
    });
  }
  res.json(CancelInvoiceResponse.parse(row));
});

// CORE-09: `credited` is reached only through a STAMPED credit note, so this
// endpoint does not transition anything itself. It composes the existing
// machinery — draft a credit_note referencing the original (createDraft
// enforces adjustability and one-live-adjustment), validate, submit — and the
// pipeline credits the original atomically when the credit note stamps.
router.post("/invoices/:id/credit-note", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.submit");
  const params = parseOrThrow(CreditNoteInvoiceParams, req.params);
  const body = parseOrThrow(CreditNoteInvoiceBody, req.body);
  const { invoice: original, lines } = await loadForTenant(req, params.id);
  // Payables guard: the credit note copies the original's parties, so a
  // non-receivable original (e.g. a captured supplier bill) would inherit
  // the submit-guard gap through this composed draft+validate+submit path.
  await assertReceivableOriented(original);
  if (!canTransition(original.status, "credited")) {
    throw new DomainError(
      "NOT_CREDITABLE",
      `Invoice is ${original.status}; only a stamped, confirmed or settled invoice can be credited`,
      409,
    );
  }
  const bundle = await createDraft(
    {
      firmId: original.firmId,
      supplierPartyId: original.supplierPartyId,
      buyerPartyId: original.buyerPartyId,
      invoiceNumber:
        body.creditNoteNumber ?? `CN-${original.invoiceNumber}`,
      currency: original.currency,
      issueDate: new Date().toISOString().slice(0, 10),
      kind: "credit_note",
      category: original.category,
      relatedInvoiceId: original.id,
      notes: body.reason,
      lines: lines.map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        vatRate: l.vatRate,
      })),
    },
    req.principal.userId,
  );
  const validation = await validateInvoice(bundle.invoice.id, req.principal.userId);
  if (!validation.ok) {
    // Name the failing field — the fix is usually completing the client's
    // party record, and an opaque 422 hides that.
    const first = validation.errors[0];
    throw new DomainError(
      "CREDIT_NOTE_INVALID",
      `Credit note failed validation${first ? `: ${first.field} — ${first.message}` : ""}`,
      422,
    );
  }
  const submitted = await submitInvoice(bundle.invoice.id, req.principal.userId);
  await appendAudit({
    actorId: req.principal.userId,
    firmId: original.firmId,
    action: "invoice.credit_note",
    entityType: "invoice",
    entityId: original.id,
    after: {
      creditNoteId: bundle.invoice.id,
      creditNoteNumber: bundle.invoice.invoiceNumber,
      reason: body.reason,
    },
  });
  res.status(202).json(CreditNoteInvoiceResponse.parse(submitted));
});

export default router;
