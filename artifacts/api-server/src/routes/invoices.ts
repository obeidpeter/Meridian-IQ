import { Router, type IRouter } from "express";
import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
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
  BulkSubmitInvoicesBody,
  BulkSubmitInvoicesResponse,
  ExportInvoicesCsvQueryParams,
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
  GetVatPackQueryParams,
  GetVatPackResponse,
  DraftVatPackCoverNoteBody,
  DraftVatPackCoverNoteResponse,
  ListLineItemSuggestionsQueryParams,
  ListLineItemSuggestionsResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../lib/parse";
import { computeStatusLight } from "../modules/clerk/status-light";
import {
  assertCan,
  assertClientPartyScope,
  assertSameTenant,
  assertBuyerPartyAccess,
  assertPartyAccess,
  clientPartyScope,
  requireFirmScope,
  tenantFirmId,
  type Principal,
} from "../modules/auth/rbac";
import { bulkSubmit } from "../modules/invoice/bulk-submit";
import {
  closedLagosMonths,
  computeVatPack,
} from "../modules/clerk/vat-pack";
import { draftVatCoverNote } from "../modules/clerk/vat-note";
import { getClerkGateway } from "../modules/clerk/provider";
import { listLineItemSuggestions } from "../modules/invoice/line-items";
import { sendCsvAttachment, toCsv } from "../lib/csv";
import { likePattern } from "../lib/sql";
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
import { requireFlag } from "../modules/flags/flags";

const router: IRouter = Router();

// The SEC-03 invoice tenancy loader, shared with the SME escalation routes
// (routes/sme.ts): one definition of "this principal may reach this invoice".
export async function loadForTenant(req: { principal: import("../modules/auth/rbac").Principal }, id: string) {
  const bundle = await getInvoiceWithLines(id);
  if (!bundle) throw new DomainError("NOT_FOUND", "Invoice not found", 404);
  assertSameTenant(req.principal, bundle.invoice.firmId);
  // A client_user may only reach invoices where it is the supplier — not a
  // sibling client's invoice within the same firm (SEC-03). No-op for firm
  // staff/admin and cross-tenant roles.
  assertClientPartyScope(req.principal, bundle.invoice.supplierPartyId);
  return bundle;
}

// The tenant/SEC-03/status/q conditions shared by the invoices list and its
// CSV export — one definition of "what the caller can read". `q` must already
// be trimmed by the caller.
function invoiceListConditions(
  principal: Principal,
  opts: { status?: string; q?: string },
): SQL[] {
  const tenant = tenantFirmId(principal);
  const conditions: SQL[] = [];
  if (tenant) conditions.push(eq(invoicesTable.firmId, tenant));
  // A client_user only sees invoices where it is the supplier — not sibling
  // clients of the same firm (SEC-03).
  const scope = clientPartyScope(principal);
  if (scope) conditions.push(eq(invoicesTable.supplierPartyId, scope));
  if (opts.status)
    conditions.push(eq(invoicesTable.status, opts.status as never));
  // Search matches the invoice number or either party's legal name.
  if (opts.q) {
    const pattern = likePattern(opts.q);
    conditions.push(sql`(
      ${invoicesTable.invoiceNumber} ILIKE ${pattern}
      OR EXISTS (
        SELECT 1 FROM parties p
        WHERE (p.id = ${invoicesTable.supplierPartyId}
            OR p.id = ${invoicesTable.buyerPartyId})
          AND p.legal_name ILIKE ${pattern}
      )
    )`);
  }
  return conditions;
}

router.get("/invoices", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const query = ListInvoicesQueryParams.safeParse(req.query);
  const status = query.success ? query.data.status : undefined;
  const limit = query.success ? query.data.limit : undefined;
  const offset = query.success ? query.data.offset : undefined;
  const q = query.success ? query.data.q?.trim() : undefined;
  const conditions = invoiceListConditions(req.principal, { status, q });

  // Paged/search requests are newest-first and bounded; a bare request keeps
  // the legacy full-list oldest-first behaviour for existing clients (mobile).
  const paged = limit !== undefined || offset !== undefined || !!q;
  let builder = getDb()
    .select()
    .from(invoicesTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(
      paged ? desc(invoicesTable.createdAt) : asc(invoicesTable.createdAt),
    )
    .$dynamic();
  if (paged) builder = builder.limit(limit ?? 50).offset(offset ?? 0);
  const rows = await builder;
  res.json(ListInvoicesResponse.parse(rows));
});

router.post("/invoices", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.write");
  const firmId = requireFirmScope(req.principal);
  const parsed = parseOrThrow(CreateInvoiceBody, req.body);
  const bundle = await createDraft(
    { firmId, ...parsed },
    req.principal.userId,
  );
  res.status(201).json(CreateInvoiceResponse.parse(bundle));
});

// CSV export of the same tenant/SEC-03/status/q-scoped list the invoices page
// shows — the rows the caller can already read, in a file their accountant
// can open. Newest first, bounded far above any realistic book.
router.get("/invoices/export", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const query = ExportInvoicesCsvQueryParams.safeParse(req.query);
  const status = query.success ? query.data.status : undefined;
  const q = query.success ? query.data.q?.trim() : undefined;
  const conditions = invoiceListConditions(req.principal, { status, q });
  const rows = await getDb()
    .select()
    .from(invoicesTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(invoicesTable.createdAt))
    .limit(50_000);

  const partyIds = [
    ...new Set(rows.flatMap((r) => [r.supplierPartyId, r.buyerPartyId])),
  ];
  const names = new Map(
    partyIds.length
      ? (
          await getDb()
            .select({ id: partiesTable.id, legalName: partiesTable.legalName })
            .from(partiesTable)
            .where(inArray(partiesTable.id, partyIds))
        ).map((p) => [p.id, p.legalName])
      : [],
  );

  const csv = toCsv(
    [
      "invoiceNumber",
      "kind",
      "status",
      "category",
      "issueDate",
      "dueDate",
      "currency",
      "subtotal",
      "vatTotal",
      "grandTotal",
      "supplier",
      "buyer",
      "createdAt",
    ],
    rows.map((r) => [
      r.invoiceNumber,
      r.kind,
      r.status,
      r.category,
      r.issueDate,
      r.dueDate,
      r.currency,
      r.subtotal,
      r.vatTotal,
      r.grandTotal,
      names.get(r.supplierPartyId) ?? r.supplierPartyId,
      names.get(r.buyerPartyId) ?? r.buyerPartyId,
      r.createdAt.toISOString(),
    ]),
  );
  sendCsvAttachment(
    res,
    `invoices-${new Date().toISOString().slice(0, 10)}.csv`,
    csv,
  );
});

// Monthly VAT filing pack (exhaust idea #2): per-client output VAT for a
// closed Lagos month, deterministic and computed on demand — the firm-level
// view of the per-client statement facts. Firm principals only (a client_user
// must never see sibling clients' VAT figures).
async function resolveVatPack(principal: Principal, rawQuery: unknown) {
  assertCan(principal, "console.portfolio.read");
  const firmId = requireFirmScope(principal);
  const query = parseOrThrow(GetVatPackQueryParams, rawQuery);
  const months = closedLagosMonths();
  const month = query.month ?? months[0];
  if (!months.includes(month)) {
    throw new DomainError(
      "BAD_MONTH",
      "month must be one of the last 12 closed Lagos months (YYYY-MM-01)",
      400,
    );
  }
  return computeVatPack(firmId, month);
}

router.get("/vat-pack", async (req, res): Promise<void> => {
  const pack = await resolveVatPack(req.principal, req.query);
  res.json(GetVatPackResponse.parse(pack));
});

router.get("/vat-pack/export", async (req, res): Promise<void> => {
  // resolveVatPack parses the (identical) query schema; no second parse.
  const pack = await resolveVatPack(req.principal, req.query);
  const csv = toCsv(
    [
      "client",
      "acceptedInvoices",
      "acceptedTotal",
      "outputVat",
      "creditNotes",
      "creditVat",
      "netOutputVat",
    ],
    [
      ...pack.rows.map((r) => [
        r.clientName,
        String(r.acceptedCount),
        r.acceptedTotal,
        r.acceptedVat,
        String(r.creditCount),
        r.creditVat,
        r.netVat,
      ]),
      [
        "TOTAL",
        String(pack.totals.acceptedCount),
        pack.totals.acceptedTotal,
        pack.totals.acceptedVat,
        String(pack.totals.creditCount),
        pack.totals.creditVat,
        pack.totals.netVat,
      ],
      // The disclosure travels WITH the file a partner hands around.
      [pack.note, "", "", "", "", "", ""],
    ],
  );
  sendCsvAttachment(res, `vat-pack-${pack.monthStart.slice(0, 7)}.csv`, csv);
});

// VAT filing cover note (round-4 idea #6): phrases the pack's computed facts
// into a note the partner edits and owns. Digest posture end to end — kill
// switch, missing provider, exhausted budget or invalid output all answer
// with the deterministic template (never an error), so there is no route
// budget pre-check: the gateway backstop turns an exhausted allowance into
// the fallback, exactly like the failure explainer.
router.post("/vat-pack/cover-note", async (req, res): Promise<void> => {
  assertCan(req.principal, "console.portfolio.read");
  const firmId = requireFirmScope(req.principal);
  const body = parseOrThrow(DraftVatPackCoverNoteBody, req.body ?? {});
  const months = closedLagosMonths();
  const month = body.month ?? months[0];
  if (!months.includes(month)) {
    throw new DomainError(
      "BAD_MONTH",
      "month must be one of the last 12 closed Lagos months (YYYY-MM-01)",
      400,
    );
  }
  const gateway = await getClerkGateway().catch(() => null);
  const note = await draftVatCoverNote(firmId, month, gateway);
  res.json(DraftVatPackCoverNoteResponse.parse(note));
});

// Frequent line items (round-4 idea #1): mined on demand from the client's
// own invoices, nothing stored, no model. Same SEC-03 resolution as the
// recurring suggestions: a client_user is pinned to its own party; a firm
// principal names the client.
router.get("/line-item-suggestions", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const query = parseOrThrow(ListLineItemSuggestionsQueryParams, req.query);
  const firmId = requireFirmScope(req.principal);
  const target = clientPartyScope(req.principal) ?? query.clientPartyId;
  if (!target) {
    throw new DomainError("MISSING_CLIENT", "clientPartyId is required", 400);
  }
  assertClientPartyScope(req.principal, target);
  const items = await listLineItemSuggestions(firmId, target);
  res.json(ListLineItemSuggestionsResponse.parse(items));
});

// Bulk validate & submit: same capability, party-access and consent gates as
// a single submit — the batch only adds iteration. Selection is server-side
// (the client's pending drafts, oldest first) so a paginated UI doesn't have
// to know every draft id.
router.post("/invoices/bulk-submit", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.submit");
  const body = parseOrThrow(BulkSubmitInvoicesBody, req.body);
  await assertPartyAccess(req.principal, body.clientPartyId);
  const result = await bulkSubmit(
    body.clientPartyId,
    tenantFirmId(req.principal),
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

router.get("/invoices/:id/ubl", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const params = parseOrThrow(GetInvoiceUblParams, req.params);
  await loadForTenant(req, params.id);
  const canonical = await buildCanonical(params.id);
  res.json(GetInvoiceUblResponse.parse({ xml: serializeToUbl(canonical) }));
});

router.get("/invoices/:id/canonical", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const params = parseOrThrow(GetInvoiceCanonicalParams, req.params);
  await loadForTenant(req, params.id);
  const canonical = await buildCanonical(params.id);
  res.json(GetInvoiceCanonicalResponse.parse(canonical));
});

router.get("/invoices/:id/stamp", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const params = parseOrThrow(GetInvoiceStampParams, req.params);
  await loadForTenant(req, params.id);
  const [stamp] = await getDb()
    .select()
    .from(stampRecordsTable)
    .where(eq(stampRecordsTable.invoiceId, params.id))
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
  const params = parseOrThrow(ListSubmissionAttemptsParams, req.params);
  await loadForTenant(req, params.id);
  const rows = await getDb()
    .select()
    .from(submissionAttemptsTable)
    .where(eq(submissionAttemptsTable.invoiceId, params.id))
    .orderBy(asc(submissionAttemptsTable.attemptNo));
  res.json(ListSubmissionAttemptsResponse.parse(rows));
});

// Task #40: deterministic status light. Pure rules over spine data — no AI
// involved — so it is safe for every invoice reader and needs no flag.
router.get("/invoices/:id/status-light", async (req, res): Promise<void> => {
  assertCan(req.principal, "invoice.read");
  const params = parseOrThrow(GetInvoiceStatusLightParams, req.params);
  const { invoice } = await loadForTenant(req, params.id);
  const [attempts, confirmations, stamps] = await Promise.all([
    getDb()
      .select()
      .from(submissionAttemptsTable)
      .where(eq(submissionAttemptsTable.invoiceId, params.id)),
    getDb()
      .select()
      .from(confirmationsTable)
      .where(eq(confirmationsTable.invoiceId, params.id)),
    getDb()
      .select()
      .from(stampRecordsTable)
      .where(eq(stampRecordsTable.invoiceId, params.id))
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

// Buyer confirmations are a release-tagged (R1) feature: unreachable when dark.
router.get("/invoices/:id/confirmations", requireFlag("buyer_confirmations"), async (req, res): Promise<void> => {
  assertCan(req.principal, "confirmation.read");
  const params = parseOrThrow(ListConfirmationsParams, req.params);
  await loadForTenant(req, params.id);
  const rows = await getDb()
    .select()
    .from(confirmationsTable)
    .where(eq(confirmationsTable.invoiceId, params.id))
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
router.post("/invoices/:id/confirmations", requireFlag("buyer_confirmations"), async (req, res): Promise<void> => {
  const params = parseOrThrow(CreateConfirmationParams, req.params);
  const parsed = parseOrThrow(CreateConfirmationBody, req.body);
  const isRequest = parsed.state === "requested";

  let invoice;
  if (isRequest) {
    assertCan(req.principal, "confirmation.write");
    ({ invoice } = await loadForTenant(req, params.id));
  } else {
    // Buyer-side response: scoped by buyer Party, not by firm tenancy.
    assertCan(req.principal, "confirmation.respond");
    const bundle = await getInvoiceWithLines(params.id);
    if (!bundle) throw new DomainError("NOT_FOUND", "Invoice not found", 404);
    invoice = bundle.invoice;
    assertBuyerPartyAccess(req.principal, invoice.buyerPartyId);
  }

  // The confirmation always belongs to the invoice's own buyer; a mismatched
  // body buyerPartyId must never be trusted (it would bypass the TIN gate and
  // could reference a cross-tenant party).
  if (parsed.buyerPartyId !== invoice.buyerPartyId) {
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
    .where(eq(confirmationsTable.invoiceId, params.id))
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
    if (!parsed.method) {
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
      invoiceId: params.id,
      buyerPartyId: invoice.buyerPartyId,
      state: parsed.state,
      method: parsed.method ?? null,
      noSetOff: parsed.noSetOff ?? false,
      note: parsed.note ?? null,
      // BR-02: the confirming user is captured on buyer responses with lineage.
      confirmingUserId: isRequest ? null : req.principal.userId,
    })
    .returning();
  if (parsed.state === "confirmed" && canTransition(invoice.status, "confirmed")) {
    // Compare-and-set: if the invoice moved concurrently (cancel/credit), the
    // confirmation row stands as lineage but the status transition is skipped.
    const [moved] = await getDb()
      .update(invoicesTable)
      .set({ status: "confirmed" })
      .where(
        and(
          eq(invoicesTable.id, params.id),
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
  const params = parseOrThrow(ListSettlementsParams, req.params);
  await loadForTenant(req, params.id);
  const rows = await getDb()
    .select()
    .from(settlementEventsTable)
    .where(eq(settlementEventsTable.invoiceId, params.id))
    .orderBy(asc(settlementEventsTable.occurredAt));
  res.json(ListSettlementsResponse.parse(rows));
});

router.post("/invoices/:id/settlements", async (req, res): Promise<void> => {
  assertCan(req.principal, "settlement.write");
  const params = parseOrThrow(CreateSettlementParams, req.params);
  const parsed = parseOrThrow(CreateSettlementBody, req.body);
  const { invoice } = await loadForTenant(req, params.id);
  const [row] = await getDb()
    .insert(settlementEventsTable)
    .values({
      invoiceId: params.id,
      source: parsed.source,
      amount: parsed.amount,
      confidence: parsed.confidence ?? null,
      occurredAt: parsed.occurredAt,
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
