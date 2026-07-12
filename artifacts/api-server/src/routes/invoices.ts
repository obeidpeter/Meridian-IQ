import { Router, type IRouter } from "express";
import { and, asc, desc, eq } from "drizzle-orm";
import {
  getDb,
  invoicesTable,
  stampRecordsTable,
  submissionAttemptsTable,
  confirmationsTable,
  settlementEventsTable,
  partiesTable,
  outboxTable,
} from "@workspace/db";
import {
  ListInvoicesQueryParams,
  ListInvoicesResponse,
  CreateInvoiceBody,
  CreateInvoiceResponse,
  GetInvoiceParams,
  GetInvoiceResponse,
  UpdateInvoiceParams,
  UpdateInvoiceBody,
  UpdateInvoiceResponse,
  ValidateInvoiceParams,
  ValidateInvoiceResponse,
  SubmitInvoiceParams,
  SubmitInvoiceResponse,
  CancelInvoiceParams,
  CancelInvoiceBody,
  CancelInvoiceResponse,
  CreditNoteInvoiceParams,
  CreditNoteInvoiceBody,
  CreditNoteInvoiceResponse,
  GetInvoiceUblParams,
  GetInvoiceUblResponse,
  GetInvoiceCanonicalParams,
  GetInvoiceCanonicalResponse,
  GetInvoiceStampParams,
  GetInvoiceStampResponse,
  ListSubmissionAttemptsParams,
  ListSubmissionAttemptsResponse,
  ListConfirmationsParams,
  ListConfirmationsResponse,
  CreateConfirmationParams,
  CreateConfirmationBody,
  CreateConfirmationResponse,
  ListSettlementsParams,
  ListSettlementsResponse,
  CreateSettlementParams,
  CreateSettlementBody,
  CreateSettlementResponse,
  GetInvoiceStatusLightParams,
  GetInvoiceStatusLightResponse,
} from "@workspace/api-zod";
import { computeStatusLight } from "../modules/clerk/status-light";
import {
  assertCan,
  assertClientPartyScope,
  assertSameTenant,
  assertBuyerPartyAccess,
  clientPartyScope,
  tenantFirmId,
} from "../modules/auth/rbac";
import {
  createDraft,
  getInvoiceWithLines,
  buildCanonical,
  validateInvoice,
  submitInvoice,
  updateInvoiceContent,
} from "../modules/invoice/service";
import {
  canTransition,
  applyTransition,
  isPresentableAsEligible,
  recordTransition,
} from "../modules/invoice/lifecycle";
import { serializeToUbl } from "../modules/invoice/canonical";
import { appendAudit } from "../modules/audit/audit";
import { DomainError } from "../modules/errors";
import { isFeatureEnabled } from "../modules/flags/flags";

const router: IRouter = Router();

async function loadForTenant(req: { principal: import("../modules/auth/rbac").Principal }, id: string) {
  const bundle = await getInvoiceWithLines(id);
  if (!bundle) throw new DomainError("NOT_FOUND", "Invoice not found", 404);
  assertSameTenant(req.principal, bundle.invoice.firmId);
  // A client_user may only reach invoices where it is the supplier — not a
  // sibling client's invoice within the same firm (SEC-03). No-op for firm
  // staff/admin and cross-tenant roles.
  assertClientPartyScope(req.principal, bundle.invoice.supplierPartyId);
  return bundle;
}

router.get("/invoices", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const query = ListInvoicesQueryParams.safeParse(req.query);
  const status = query.success ? query.data.status : undefined;
  const tenant = tenantFirmId(req.principal);
  const conditions = [];
  if (tenant) conditions.push(eq(invoicesTable.firmId, tenant));
  // A client_user only sees invoices where it is the supplier — not sibling
  // clients of the same firm (SEC-03).
  const scope = clientPartyScope(req.principal);
  if (scope) conditions.push(eq(invoicesTable.supplierPartyId, scope));
  if (status) conditions.push(eq(invoicesTable.status, status as never));
  const rows = conditions.length
    ? await getDb()
        .select()
        .from(invoicesTable)
        .where(and(...conditions))
        .orderBy(asc(invoicesTable.createdAt))
    : await getDb().select().from(invoicesTable).orderBy(asc(invoicesTable.createdAt));
  res.json(ListInvoicesResponse.parse(rows));
});

router.post("/invoices", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.write");
  const firmId = tenantFirmId(req.principal);
  if (!firmId) {
    res.status(403).json({ error: "A firm-scoped principal is required" });
    return;
  }
  const parsed = CreateInvoiceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const bundle = await createDraft(
    { firmId, ...parsed.data },
    req.principal.userId,
  );
  res.status(201).json(CreateInvoiceResponse.parse(bundle));
});

router.get("/invoices/:id", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const params = GetInvoiceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const bundle = await loadForTenant(req, params.data.id);
  res.json(GetInvoiceResponse.parse(bundle));
});

// Fix-and-retry: correct the content of an invoice that is still mutable per
// the lifecycle (draft, validated, failed). The service is the authority —
// assertMutableContent 409s for submitted/stamped/terminal invoices, and a
// validated invoice reverts to draft so stale validation cannot be submitted.
router.patch("/invoices/:id", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.write");
  const params = UpdateInvoiceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = UpdateInvoiceBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  await loadForTenant(req, params.data.id);
  const bundle = await updateInvoiceContent(
    params.data.id,
    body.data,
    req.principal.userId,
  );
  res.json(UpdateInvoiceResponse.parse(bundle));
});

router.post("/invoices/:id/validate", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.write");
  const params = ValidateInvoiceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await loadForTenant(req, params.data.id);
  const result = await validateInvoice(params.data.id, req.principal.userId);
  res.json(ValidateInvoiceResponse.parse(result));
});

router.post("/invoices/:id/submit", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.submit");
  const params = SubmitInvoiceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await loadForTenant(req, params.data.id);
  const invoice = await submitInvoice(params.data.id, req.principal.userId);
  res.status(202).json(SubmitInvoiceResponse.parse(invoice));
});

router.post("/invoices/:id/cancel", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.write");
  const params = CancelInvoiceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  // CORE-09: cancellation is a first-class lifecycle event and always carries a
  // stated reason.
  const body = CancelInvoiceBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const { invoice } = await loadForTenant(req, params.data.id);
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
    reason: body.data.reason,
  });
  await appendAudit({
    actorId: req.principal.userId,
    firmId: invoice.firmId,
    action: "invoice.cancel",
    entityType: "invoice",
    entityId: invoice.id,
    before: { status: invoice.status },
    after: { status: "cancelled", reason: body.data.reason },
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
  const params = CreditNoteInvoiceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = CreditNoteInvoiceBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const { invoice: original, lines } = await loadForTenant(req, params.data.id);
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
        body.data.creditNoteNumber ?? `CN-${original.invoiceNumber}`,
      currency: original.currency,
      issueDate: new Date().toISOString().slice(0, 10),
      kind: "credit_note",
      category: original.category,
      relatedInvoiceId: original.id,
      notes: body.data.reason,
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
      reason: body.data.reason,
    },
  });
  res.status(202).json(CreditNoteInvoiceResponse.parse(submitted));
});

router.get("/invoices/:id/ubl", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const params = GetInvoiceUblParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await loadForTenant(req, params.data.id);
  const canonical = await buildCanonical(params.data.id);
  res.json(GetInvoiceUblResponse.parse({ xml: serializeToUbl(canonical) }));
});

router.get("/invoices/:id/canonical", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const params = GetInvoiceCanonicalParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await loadForTenant(req, params.data.id);
  const canonical = await buildCanonical(params.data.id);
  res.json(GetInvoiceCanonicalResponse.parse(canonical));
});

router.get("/invoices/:id/stamp", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const params = GetInvoiceStampParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await loadForTenant(req, params.data.id);
  const [stamp] = await getDb()
    .select()
    .from(stampRecordsTable)
    .where(eq(stampRecordsTable.invoiceId, params.data.id))
    .orderBy(asc(stampRecordsTable.createdAt))
    .limit(1);
  if (!stamp) {
    res.status(404).json({ error: "No stamp for this invoice" });
    return;
  }
  res.json(GetInvoiceStampResponse.parse(stamp));
});

router.get("/invoices/:id/attempts", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const params = ListSubmissionAttemptsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await loadForTenant(req, params.data.id);
  const rows = await getDb()
    .select()
    .from(submissionAttemptsTable)
    .where(eq(submissionAttemptsTable.invoiceId, params.data.id))
    .orderBy(asc(submissionAttemptsTable.attemptNo));
  res.json(ListSubmissionAttemptsResponse.parse(rows));
});

// Task #40: deterministic status light. Pure rules over spine data — no AI
// involved — so it is safe for every invoice reader and needs no flag.
router.get("/invoices/:id/status-light", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const params = GetInvoiceStatusLightParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const { invoice } = await loadForTenant(req, params.data.id);
  const [attempts, confirmations, stamps] = await Promise.all([
    getDb()
      .select()
      .from(submissionAttemptsTable)
      .where(eq(submissionAttemptsTable.invoiceId, params.data.id)),
    getDb()
      .select()
      .from(confirmationsTable)
      .where(eq(confirmationsTable.invoiceId, params.data.id)),
    getDb()
      .select()
      .from(stampRecordsTable)
      .where(eq(stampRecordsTable.invoiceId, params.data.id))
      .orderBy(asc(stampRecordsTable.createdAt))
      .limit(1),
  ]);
  const light = computeStatusLight({
    invoice,
    attempts,
    confirmations,
    stamp: stamps[0] ?? null,
  });
  res.json(GetInvoiceStatusLightResponse.parse(light));
});

router.get("/invoices/:id/confirmations", async (req, res): Promise<void> => {
  // Buyer confirmations are a release-tagged (R1) feature: unreachable when dark.
  if (!(await isFeatureEnabled("buyer_confirmations", req.principal.firmId))) {
    res.sendStatus(404);
    return;
  }
  assertCan(req.principal, "confirmation.read");
  const params = ListConfirmationsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await loadForTenant(req, params.data.id);
  const rows = await getDb()
    .select()
    .from(confirmationsTable)
    .where(eq(confirmationsTable.invoiceId, params.data.id))
    .orderBy(asc(confirmationsTable.createdAt));
  res.json(ListConfirmationsResponse.parse(rows));
});

// BR-02 confirmation workflow. One write path to the spine, two sides:
//   - The supplier's firm requests confirmation (state=requested) on a stamped
//     invoice (confirmation.write).
//   - The buyer organization responds (confirmed/queried/rejected) via a
//     buyer_user principal scoped to the invoice's buyer Party
//     (confirmation.respond), with confirming user and method captured.
// Lineage is append-only rows; a response requires an open `requested` row.
router.post("/invoices/:id/confirmations", async (req, res): Promise<void> => {
  if (!(await isFeatureEnabled("buyer_confirmations", req.principal.firmId))) {
    res.sendStatus(404);
    return;
  }
  const params = CreateConfirmationParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = CreateConfirmationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const isRequest = parsed.data.state === "requested";

  let invoice;
  if (isRequest) {
    assertCan(req.principal, "confirmation.write");
    ({ invoice } = await loadForTenant(req, params.data.id));
  } else {
    // Buyer-side response: scoped by buyer Party, not by firm tenancy.
    assertCan(req.principal, "confirmation.respond");
    const bundle = await getInvoiceWithLines(params.data.id);
    if (!bundle) throw new DomainError("NOT_FOUND", "Invoice not found", 404);
    invoice = bundle.invoice;
    assertBuyerPartyAccess(req.principal, invoice.buyerPartyId);
  }

  // The confirmation always belongs to the invoice's own buyer; a mismatched
  // body buyerPartyId must never be trusted (it would bypass the TIN gate and
  // could reference a cross-tenant party).
  if (parsed.data.buyerPartyId !== invoice.buyerPartyId) {
    throw new DomainError(
      "BUYER_PARTY_MISMATCH",
      "Confirmation buyerPartyId must match the invoice buyer",
      409,
    );
  }
  // A party without a validated TIN cannot enter the confirmation workflow
  // (CORE-08 / BR-02): confirmations feed VAT protection and financeability.
  const [buyer] = await getDb()
    .select({ tinValidated: partiesTable.tinValidated })
    .from(partiesTable)
    .where(eq(partiesTable.id, invoice.buyerPartyId))
    .limit(1);
  if (!buyer?.tinValidated) {
    throw new DomainError(
      "TIN_NOT_VALIDATED",
      "Buyer TIN must be validated before entering the confirmation workflow",
      422,
    );
  }

  // Record-level state machine over the append-only lineage.
  const [latest] = await getDb()
    .select()
    .from(confirmationsTable)
    .where(eq(confirmationsTable.invoiceId, params.data.id))
    .orderBy(desc(confirmationsTable.createdAt))
    .limit(1);
  if (isRequest) {
    // Confirmation is requested on a stamped invoice; re-requesting is allowed
    // only after a queried/rejected response (Appendix B).
    if (invoice.status !== "stamped") {
      throw new DomainError(
        "NOT_STAMPED",
        "Confirmation can only be requested on a stamped invoice",
        409,
      );
    }
    if (latest && (latest.state === "requested" || latest.state === "confirmed")) {
      throw new DomainError(
        "CONFIRMATION_ALREADY_OPEN",
        `Confirmation is already ${latest.state}`,
        409,
      );
    }
  } else {
    if (!latest || latest.state !== "requested") {
      throw new DomainError(
        "NO_OPEN_REQUEST",
        "A confirmation response requires an open request",
        409,
      );
    }
    if (!parsed.data.method) {
      throw new DomainError(
        "METHOD_REQUIRED",
        "A confirmation response must state its method",
        400,
      );
    }
    // CORE-09: an invoice cancelled or credited after the request was raised
    // can no longer collect a confirmation (a confirmed dead invoice would
    // read as financeable evidence).
    if (!isPresentableAsEligible(invoice.status)) {
      throw new DomainError(
        "INVOICE_NOT_ELIGIBLE",
        `Invoice is ${invoice.status}; the confirmation request is void`,
        409,
      );
    }
  }

  const [row] = await getDb()
    .insert(confirmationsTable)
    .values({
      invoiceId: params.data.id,
      buyerPartyId: invoice.buyerPartyId,
      state: parsed.data.state,
      method: parsed.data.method ?? null,
      noSetOff: parsed.data.noSetOff ?? false,
      note: parsed.data.note ?? null,
      // BR-02: the confirming user is captured on buyer responses with lineage.
      confirmingUserId: isRequest ? null : req.principal.userId,
    })
    .returning();
  if (parsed.data.state === "confirmed" && canTransition(invoice.status, "confirmed")) {
    // Compare-and-set: if the invoice moved concurrently (cancel/credit), the
    // confirmation row stands as lineage but the status transition is skipped.
    const [moved] = await getDb()
      .update(invoicesTable)
      .set({ status: "confirmed" })
      .where(
        and(
          eq(invoicesTable.id, params.data.id),
          eq(invoicesTable.status, invoice.status),
        ),
      )
      .returning({ id: invoicesTable.id });
    if (moved) {
      await recordTransition({
        invoiceId: invoice.id,
        firmId: invoice.firmId,
        fromStatus: invoice.status,
        toStatus: "confirmed",
        actorId: req.principal.userId,
        actorRole: req.principal.role,
      });
    }
  }
  await appendAudit({
    actorId: req.principal.userId,
    firmId: invoice.firmId,
    action: "invoice.confirmation",
    entityType: "confirmation",
    entityId: row.id,
    after: { state: row.state, method: row.method, noSetOff: row.noSetOff },
  });
  res.status(201).json(CreateConfirmationResponse.parse(row));
});

router.get("/invoices/:id/settlements", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const params = ListSettlementsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await loadForTenant(req, params.data.id);
  const rows = await getDb()
    .select()
    .from(settlementEventsTable)
    .where(eq(settlementEventsTable.invoiceId, params.data.id))
    .orderBy(asc(settlementEventsTable.occurredAt));
  res.json(ListSettlementsResponse.parse(rows));
});

router.post("/invoices/:id/settlements", async (req, res): Promise<void> => {
  assertCan(req.principal, "settlement.write");
  const params = CreateSettlementParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = CreateSettlementBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { invoice } = await loadForTenant(req, params.data.id);
  const [row] = await getDb()
    .insert(settlementEventsTable)
    .values({
      invoiceId: params.data.id,
      source: parsed.data.source,
      amount: parsed.data.amount,
      confidence: parsed.data.confidence ?? null,
      occurredAt: parsed.data.occurredAt,
    })
    .returning();
  await appendAudit({
    actorId: req.principal.userId,
    firmId: invoice.firmId,
    action: "invoice.settlement",
    entityType: "settlement_event",
    entityId: row.id,
    after: { source: row.source, amount: row.amount },
  });
  res.status(201).json(CreateSettlementResponse.parse(row));
});

export default router;
