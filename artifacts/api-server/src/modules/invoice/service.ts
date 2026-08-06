import { asc, eq, sql } from "drizzle-orm";
import {
  getDb,
  invoicesTable,
  invoiceLinesTable,
  invoiceLifecycleEventsTable,
  partiesTable,
  outboxTable,
  type Invoice,
  type InvoiceLine,
} from "@workspace/db";
import { DomainError } from "../errors";
import { appendAudit } from "../audit/audit";
import { isPurposePermitted } from "../consent/consent";
import {
  applyTransition,
  assertMutableContent,
  recordTransition,
} from "./lifecycle";
import {
  validateCanonical,
  type CanonicalInvoice,
  type FieldError,
} from "./canonical";
import {
  assertPlausibleVatRates,
  computeLineFinancials,
  money,
  type LineInput,
} from "./lines";
import { computeLinesWithTotals, type ComputedLine } from "./line-totals";
import { invoiceOrientation } from "./payables";
import { assertSubmitApproved, revokeLiveApprovals } from "./approvals";

export { computeLineFinancials, type LineInput };

// Payables guard (contract 0.44.0): only a RECEIVABLE-oriented invoice — one
// whose supplier is a client the firm engages — may enter the stamping
// lifecycle. A captured supplier BILL (the client is the buyer) must stay a
// draft forever; without this guard a firm principal could submit a vendor's
// document to the rails under the client's name, and only the vendor's
// missing consent would (accidentally) block it. Shared by validateInvoice,
// submitInvoice and the credit-note route (routes/invoices/lifecycle.ts).
export const NOT_SUBMITTABLE_MESSAGE =
  "Only your own issued invoices can be submitted for stamping — this document's supplier is not a client of your practice.";

export async function assertReceivableOriented(invoice: {
  firmId: string;
  supplierPartyId: string;
  buyerPartyId: string;
}): Promise<void> {
  if ((await invoiceOrientation(invoice)) !== "receivable") {
    throw new DomainError("NOT_SUBMITTABLE", NOT_SUBMITTABLE_MESSAGE, 409);
  }
}

export interface CreateInvoiceInput {
  firmId: string;
  supplierPartyId: string;
  buyerPartyId: string;
  invoiceNumber: string;
  currency?: string;
  // NGN per one unit of `currency`, captured at issue time (contract 0.45.0).
  // NGN documents must not carry a rate — converters treat null as "already
  // naira" and a stored rate on NGN would double-convert.
  fxRateToNgn?: string;
  issueDate: string;
  dueDate?: string | null;
  kind?: "invoice" | "credit_note" | "correction";
  category?: "b2b" | "b2g" | "b2c";
  // WHT Desk: the withholding category a HUMAN assigned (the contract's
  // closed enum — the zod body bounds every value; a model never sets this).
  // Null/absent = no WHT applies.
  whtCategory?: string | null;
  relatedInvoiceId?: string | null;
  notes?: string | null;
  lines: LineInput[];
}

// FX capture plumbing: the column is numeric(18,6), so anything beyond six
// decimals (or non-numeric noise like "1,500") must be refused BEFORE the
// insert turns it into an opaque DB error; zero/negative rates would silently
// zero out or flip naira reporting.
function assertValidFxRate(rate: string): void {
  if (!/^\d+(\.\d{1,6})?$/.test(rate) || Number(rate) <= 0) {
    throw new DomainError(
      "FX_RATE_INVALID",
      `fxRateToNgn must be a positive decimal with at most 6 decimal places, got "${rate}"`,
      400,
    );
  }
}

// Statuses an original must have reached before a credit note or correction can
// be raised against it: adjustments target platform-accepted (stamped or later,
// non-terminal) invoices (CORE-09).
const ADJUSTABLE_STATUSES = ["stamped", "confirmed", "settled"];

// Corrections, cancellations and credit notes are first-class lifecycle
// events (CORE-09): an adjustment must name a real, same-tenant, stamped
// original; a plain invoice must not carry a relatedInvoiceId.
async function assertAdjustmentRulesSatisfied(
  input: CreateInvoiceInput,
): Promise<void> {
  const kind = input.kind ?? "invoice";
  if (kind === "credit_note" || kind === "correction") {
    if (!input.relatedInvoiceId) {
      throw new DomainError(
        "RELATED_INVOICE_REQUIRED",
        `A ${kind} must reference the stamped invoice it adjusts`,
        400,
      );
    }
    // Serialize adjustment creation per original (CON-09). The "one live
    // adjustment" check below is a read-then-insert: under READ COMMITTED two
    // concurrent credit notes for the same original both see no live sibling
    // and both insert, producing duplicate stamped credit notes. A
    // transaction-scoped advisory lock keyed on the original id makes the
    // second request wait for the first to commit, then observe the sibling and
    // reject. The lock is released when the ambient request transaction ends.
    await getDb().execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${input.relatedInvoiceId}))`,
    );
    const [original] = await getDb()
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.id, input.relatedInvoiceId))
      .limit(1);
    if (!original || original.firmId !== input.firmId) {
      throw new DomainError(
        "RELATED_INVOICE_NOT_FOUND",
        "Related invoice does not exist in this tenant",
        404,
      );
    }
    if (!ADJUSTABLE_STATUSES.includes(original.status)) {
      throw new DomainError(
        "RELATED_INVOICE_NOT_ADJUSTABLE",
        `Related invoice is ${original.status}; only a stamped, confirmed or settled invoice can be adjusted`,
        409,
      );
    }
    // One live adjustment per original: a second credit note would stamp but
    // silently fail to credit (the original is already credited), leaving an
    // orphan adjustment. Cancelled or failed adjustments free the slot.
    const adjustments = await getDb()
      .select({ id: invoicesTable.id, status: invoicesTable.status })
      .from(invoicesTable)
      .where(eq(invoicesTable.relatedInvoiceId, input.relatedInvoiceId));
    const live = adjustments.find(
      (a) => a.status !== "cancelled" && a.status !== "failed",
    );
    if (live) {
      throw new DomainError(
        "ADJUSTMENT_EXISTS",
        `Invoice already has an active adjustment (${live.id}, ${live.status})`,
        409,
      );
    }
  } else if (input.relatedInvoiceId) {
    throw new DomainError(
      "UNEXPECTED_RELATED_INVOICE",
      "Only credit notes and corrections may reference a related invoice",
      400,
    );
  }
}

// Map computed lines to invoice_lines insert rows. Shared by createDraft and
// updateInvoiceContent; bulkCreateDrafts keeps its own single-line row shape.
function toLineRows(
  invoiceId: string,
  computed: ComputedLine[],
): (typeof invoiceLinesTable.$inferInsert)[] {
  return computed.map((c) => ({
    invoiceId,
    lineNo: c.lineNo,
    description: c.description,
    quantity: c.quantity,
    unitPrice: c.unitPrice,
    vatRate: c.vatRate,
    lineExtension: c.lineExtension,
    vatAmount: c.vatAmount,
  }));
}

export async function createDraft(
  input: CreateInvoiceInput,
  actorId?: string,
): Promise<{ invoice: Invoice; lines: InvoiceLine[] }> {
  if (input.lines.length === 0) {
    throw new DomainError("NO_LINES", "An invoice needs at least one line", 400);
  }
  // Reject percent-style VAT rates before any row is written: a "7.5" that
  // should have been "0.075" would otherwise create a 100x-inflated draft.
  assertPlausibleVatRates(input.lines);
  if (input.fxRateToNgn !== undefined) {
    assertValidFxRate(input.fxRateToNgn);
    // An NGN document carries no rate by definition (currency defaults NGN).
    if ((input.currency ?? "NGN") === "NGN") {
      throw new DomainError(
        "FX_RATE_INVALID",
        "fxRateToNgn must not be set on an NGN invoice — the rate converts a foreign currency to naira",
        400,
      );
    }
  }
  await assertAdjustmentRulesSatisfied(input);
  const { computed, subtotal, vatTotal, grandTotal } = computeLinesWithTotals(
    input.lines,
  );

  const [invoice] = await getDb()
    .insert(invoicesTable)
    .values({
      firmId: input.firmId,
      supplierPartyId: input.supplierPartyId,
      buyerPartyId: input.buyerPartyId,
      invoiceNumber: input.invoiceNumber,
      currency: input.currency ?? "NGN",
      fxRateToNgn: input.fxRateToNgn ?? null,
      issueDate: input.issueDate,
      dueDate: input.dueDate ?? null,
      kind: input.kind ?? "invoice",
      category: input.category ?? "b2b",
      whtCategory: input.whtCategory ?? null,
      relatedInvoiceId: input.relatedInvoiceId ?? null,
      notes: input.notes ?? null,
      subtotal: money(subtotal),
      vatTotal: money(vatTotal),
      grandTotal: money(grandTotal),
    })
    .returning();
  const lines = await getDb()
    .insert(invoiceLinesTable)
    .values(toLineRows(invoice.id, computed))
    .returning();
  await recordTransition({
    invoiceId: invoice.id,
    firmId: input.firmId,
    fromStatus: null,
    toStatus: invoice.status,
    actorId,
  });
  await appendAudit({
    actorId,
    firmId: input.firmId,
    action: "invoice.create",
    entityType: "invoice",
    entityId: invoice.id,
    after: { invoiceNumber: invoice.invoiceNumber, status: invoice.status },
  });
  return { invoice, lines };
}

export interface BulkDraftRow {
  rowNumber: number;
  supplierPartyId: string;
  buyerPartyId: string;
  invoiceNumber: string;
  currency?: string;
  issueDate: string;
  dueDate?: string | null;
  line: LineInput;
}

// Bulk draft creation for large imports (NFR-03: a 5,000-row import must fit
// inside the request-transaction budget). Instead of per-row createDraft calls
// (~6 statements each), rows land in chunked multi-row inserts — invoices,
// lines and lifecycle events — with ONE audit entry for the whole batch. Every
// invoice still gets its creation transition row (CORE-02 lineage).
const BULK_CHUNK = 500;

export async function bulkCreateDrafts(
  firmId: string,
  rows: BulkDraftRow[],
  actorId?: string,
): Promise<{ rowNumber: number; invoiceId: string; invoiceNumber: string }[]> {
  const out: { rowNumber: number; invoiceId: string; invoiceNumber: string }[] =
    [];
  // Same guard as createDraft: percent-style VAT rates fail loudly instead of
  // producing 100x-inflated drafts. Import routes pre-validate per-row, so a
  // failure here indicates a caller bug, not user data.
  assertPlausibleVatRates(rows.map((r) => r.line));
  for (let i = 0; i < rows.length; i += BULK_CHUNK) {
    const chunk = rows.slice(i, i + BULK_CHUNK);
    const computed = chunk.map((r) => {
      const fin = computeLineFinancials(r.line);
      const subtotal = Number(fin.lineExtension);
      const vatTotal = Number(fin.vatAmount);
      return { r, fin, subtotal, vatTotal };
    });
    const inserted = await getDb()
      .insert(invoicesTable)
      .values(
        computed.map(({ r, subtotal, vatTotal }) => ({
          firmId,
          supplierPartyId: r.supplierPartyId,
          buyerPartyId: r.buyerPartyId,
          invoiceNumber: r.invoiceNumber,
          currency: r.currency ?? "NGN",
          issueDate: r.issueDate,
          dueDate: r.dueDate ?? null,
          subtotal: money(subtotal),
          vatTotal: money(vatTotal),
          grandTotal: money(subtotal + vatTotal),
        })),
      )
      .returning({
        id: invoicesTable.id,
        invoiceNumber: invoicesTable.invoiceNumber,
        status: invoicesTable.status,
      });
    await getDb()
      .insert(invoiceLinesTable)
      .values(
        inserted.map((inv, idx) => ({
          invoiceId: inv.id,
          lineNo: 1,
          description: computed[idx].r.line.description,
          quantity: computed[idx].r.line.quantity,
          unitPrice: computed[idx].r.line.unitPrice,
          vatRate: computed[idx].r.line.vatRate,
          lineExtension: computed[idx].fin.lineExtension,
          vatAmount: computed[idx].fin.vatAmount,
        })),
      );
    await getDb()
      .insert(invoiceLifecycleEventsTable)
      .values(
        inserted.map((inv) => ({
          invoiceId: inv.id,
          firmId,
          fromStatus: null,
          toStatus: inv.status,
          actorId: actorId ?? null,
        })),
      );
    inserted.forEach((inv, idx) => {
      out.push({
        rowNumber: computed[idx].r.rowNumber,
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
      });
    });
  }
  await appendAudit({
    actorId,
    firmId,
    action: "invoice.bulk_import",
    entityType: "firm",
    entityId: firmId,
    after: { count: out.length },
  });
  return out;
}

export interface UpdateInvoiceInput {
  invoiceNumber?: string;
  issueDate?: string;
  dueDate?: string | null;
  // null clears a captured rate (e.g. the currency was corrected to NGN).
  fxRateToNgn?: string | null;
  notes?: string | null;
  // WHT Desk: a string sets the category, null clears it, absent leaves it
  // untouched (the fxRateToNgn tri-state).
  whtCategory?: string | null;
  lines?: LineInput[];
}

// Update the content of an invoice that is still mutable per the lifecycle
// (draft, validated, failed — assertMutableContent is the authority). Used by
// the fix-and-retry flow: a failed invoice's data is corrected in place and the
// invoice re-submitted (failed → submitted). A validated invoice reverts to
// draft on edit so the stale validation cannot be submitted as-is.
export async function updateInvoiceContent(
  invoiceId: string,
  patch: UpdateInvoiceInput,
  actorId?: string,
): Promise<{ invoice: Invoice; lines: InvoiceLine[] }> {
  const bundle = await getInvoiceWithLines(invoiceId);
  if (!bundle) throw new DomainError("NOT_FOUND", "Invoice not found", 404);
  assertMutableContent(bundle.invoice);
  if (patch.lines && patch.lines.length === 0) {
    throw new DomainError("NO_LINES", "An invoice needs at least one line", 400);
  }

  const invoicePatch: Partial<typeof invoicesTable.$inferInsert> = {};
  if (patch.invoiceNumber !== undefined) {
    invoicePatch.invoiceNumber = patch.invoiceNumber;
  }
  if (patch.issueDate !== undefined) invoicePatch.issueDate = patch.issueDate;
  if (patch.dueDate !== undefined) invoicePatch.dueDate = patch.dueDate;
  if (patch.fxRateToNgn !== undefined) {
    if (patch.fxRateToNgn !== null) assertValidFxRate(patch.fxRateToNgn);
    invoicePatch.fxRateToNgn = patch.fxRateToNgn;
  }
  if (patch.notes !== undefined) invoicePatch.notes = patch.notes;
  if (patch.whtCategory !== undefined) {
    invoicePatch.whtCategory = patch.whtCategory;
  }

  let newLines = bundle.lines;
  if (patch.lines) {
    const { computed, subtotal, vatTotal, grandTotal } = computeLinesWithTotals(
      patch.lines,
    );
    invoicePatch.subtotal = money(subtotal);
    invoicePatch.vatTotal = money(vatTotal);
    invoicePatch.grandTotal = money(grandTotal);
    await getDb()
      .delete(invoiceLinesTable)
      .where(eq(invoiceLinesTable.invoiceId, invoiceId));
    newLines = await getDb()
      .insert(invoiceLinesTable)
      .values(toLineRows(invoiceId, computed))
      .returning();
  }

  let invoice = bundle.invoice;
  if (Object.keys(invoicePatch).length > 0) {
    const [updated] = await getDb()
      .update(invoicesTable)
      .set(invoicePatch)
      .where(eq(invoicesTable.id, invoiceId))
      .returning();
    invoice = updated;
  }

  // Maker-checker: an approval must never cover content the approver did not
  // see, so ANY successful content update revokes the invoice's live
  // approvals (revoked, never deleted — the rows stay as evidence). Under the
  // submit policy the edited invoice needs a fresh second-person approval.
  await revokeLiveApprovals(invoiceId);

  // A validated invoice's validation is stale once content changes: revert to
  // draft (compare-and-set) so it must be re-validated before submission.
  if (bundle.invoice.status === "validated") {
    invoice = await applyTransition(invoiceId, "validated", "draft");
    await recordTransition({
      invoiceId,
      firmId: bundle.invoice.firmId,
      fromStatus: "validated",
      toStatus: "draft",
      actorId,
      reason: "content edited",
    });
  }

  await appendAudit({
    actorId,
    firmId: bundle.invoice.firmId,
    action: "invoice.update",
    entityType: "invoice",
    entityId: invoiceId,
    before: {
      invoiceNumber: bundle.invoice.invoiceNumber,
      grandTotal: bundle.invoice.grandTotal,
      status: bundle.invoice.status,
    },
    after: {
      invoiceNumber: invoice.invoiceNumber,
      grandTotal: invoice.grandTotal,
      status: invoice.status,
      linesReplaced: Boolean(patch.lines),
    },
  });
  return { invoice, lines: newLines };
}

export async function getInvoiceWithLines(
  invoiceId: string,
): Promise<{ invoice: Invoice; lines: InvoiceLine[] } | null> {
  const [invoice] = await getDb()
    .select()
    .from(invoicesTable)
    .where(eq(invoicesTable.id, invoiceId))
    .limit(1);
  if (!invoice) return null;
  const lines = await getDb()
    .select()
    .from(invoiceLinesTable)
    .where(eq(invoiceLinesTable.invoiceId, invoiceId))
    .orderBy(asc(invoiceLinesTable.lineNo));
  return { invoice, lines };
}

// Build the canonical invoice from spine rows for serialization / submission.
export async function buildCanonical(
  invoiceId: string,
): Promise<CanonicalInvoice> {
  const bundle = await getInvoiceWithLines(invoiceId);
  if (!bundle) throw new DomainError("NOT_FOUND", "Invoice not found", 404);
  const { invoice, lines } = bundle;
  const [supplier] = await getDb()
    .select()
    .from(partiesTable)
    .where(eq(partiesTable.id, invoice.supplierPartyId))
    .limit(1);
  const [buyer] = await getDb()
    .select()
    .from(partiesTable)
    .where(eq(partiesTable.id, invoice.buyerPartyId))
    .limit(1);

  const typeCode = invoice.kind === "credit_note" ? "381" : "380";
  const toParty = (p: typeof supplier) => ({
    legalName: p.legalName,
    tin: p.tin ?? "",
    cacNumber: p.cacNumber,
    street: p.street ?? "",
    city: p.city ?? "",
    countryCode: p.countryCode,
  });
  return {
    invoiceNumber: invoice.invoiceNumber,
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate ?? invoice.issueDate,
    invoiceTypeCode: typeCode,
    currencyCode: invoice.currency,
    supplier: toParty(supplier),
    buyer: toParty(buyer),
    lines: lines.map((l) => ({
      id: String(l.lineNo),
      description: l.description,
      quantity: l.quantity,
      unitCode: "EA",
      unitPrice: l.unitPrice,
      vatRate: money(Number(l.vatRate) * 100),
      lineExtension: l.lineExtension,
      vatAmount: l.vatAmount,
    })),
    lineExtensionAmount: invoice.subtotal,
    taxExclusiveAmount: invoice.subtotal,
    taxAmount: invoice.vatTotal,
    taxInclusiveAmount: invoice.grandTotal,
    payableAmount: invoice.grandTotal,
  };
}

// Validate a draft against the mandatory field set and move it to `validated`.
export async function validateInvoice(
  invoiceId: string,
  actorId?: string,
): Promise<{ ok: boolean; errors: FieldError[] }> {
  const bundle = await getInvoiceWithLines(invoiceId);
  if (!bundle) throw new DomainError("NOT_FOUND", "Invoice not found", 404);
  // A supplier bill (or any non-receivable document) never enters the
  // stamping lifecycle — refuse before any field validation runs.
  await assertReceivableOriented(bundle.invoice);
  const canonical = await buildCanonical(invoiceId);
  const errors = validateCanonical(canonical);
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  // Compare-and-set: a concurrent submit/cancel between the read above and this
  // write must not be clobbered by an unconditional UPDATE (CON-01 TOCTOU).
  // applyTransition folds the from-status into the WHERE clause and 409s if the
  // invoice moved under us, before any lifecycle event is appended.
  await applyTransition(invoiceId, bundle.invoice.status, "validated");
  await recordTransition({
    invoiceId,
    firmId: bundle.invoice.firmId,
    fromStatus: bundle.invoice.status,
    toStatus: "validated",
    actorId,
  });
  await appendAudit({
    actorId,
    firmId: bundle.invoice.firmId,
    action: "invoice.validate",
    entityType: "invoice",
    entityId: invoiceId,
    before: { status: bundle.invoice.status },
    after: { status: "validated" },
  });
  return { ok: true, errors: [] };
}

// Move a validated invoice to `submitted` and enqueue it on the async pipeline.
// Requires layer-one compliance consent for the supplier (CORE-03).
export async function submitInvoice(
  invoiceId: string,
  actorId?: string,
): Promise<Invoice> {
  const bundle = await getInvoiceWithLines(invoiceId);
  if (!bundle) throw new DomainError("NOT_FOUND", "Invoice not found", 404);
  // Orientation before consent: a bill must refuse as NOT_SUBMITTABLE, not
  // ride on the vendor's (correctly absent) consent record.
  await assertReceivableOriented(bundle.invoice);
  // Maker-checker (firm_policies): when the firm requires it, a live approval
  // by someone OTHER than this actor must exist, or the submit 409s
  // APPROVAL_REQUIRED. After orientation (a bill stays NOT_SUBMITTABLE, never
  // "needs approval") and before consent (an unapproved submit must not leak
  // the supplier's consent standing).
  await assertSubmitApproved(bundle.invoice, actorId);
  const permitted = await isPurposePermitted(
    bundle.invoice.supplierPartyId,
    "compliance_submission",
  );
  if (!permitted) {
    throw new DomainError(
      "CONSENT_REQUIRED",
      "Supplier has not granted compliance (layer 1) consent",
      403,
    );
  }
  // Compare-and-set before enqueueing: a double-submit (double-click or
  // timeout-retry) must not append two lifecycle events and two outbox jobs.
  // applyTransition 409s the second caller because the row is no longer
  // `validated`, so exactly one `invoice.submit` is enqueued (CON-01).
  const updated = await applyTransition(
    invoiceId,
    bundle.invoice.status,
    "submitted",
  );
  await getDb().insert(outboxTable).values({
    aggregateType: "invoice",
    aggregateId: invoiceId,
    type: "invoice.submit",
    payload: { invoiceId },
  });
  await recordTransition({
    invoiceId,
    firmId: bundle.invoice.firmId,
    fromStatus: bundle.invoice.status,
    toStatus: "submitted",
    actorId,
  });
  await appendAudit({
    actorId,
    firmId: bundle.invoice.firmId,
    action: "invoice.submit",
    entityType: "invoice",
    entityId: invoiceId,
    before: { status: bundle.invoice.status },
    after: { status: "submitted" },
  });
  return updated;
}
