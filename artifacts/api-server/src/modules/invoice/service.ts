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
import { applyTransition, recordTransition } from "./lifecycle";
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

export { computeLineFinancials, type LineInput };

export interface CreateInvoiceInput {
  firmId: string;
  supplierPartyId: string;
  buyerPartyId: string;
  invoiceNumber: string;
  currency?: string;
  issueDate: string;
  dueDate?: string | null;
  kind?: "invoice" | "credit_note" | "correction";
  category?: "b2b" | "b2g" | "b2c";
  relatedInvoiceId?: string | null;
  notes?: string | null;
  lines: LineInput[];
}

// Statuses an original must have reached before a credit note or correction can
// be raised against it: adjustments target platform-accepted (stamped or later,
// non-terminal) invoices (CORE-09).
const ADJUSTABLE_STATUSES = ["stamped", "confirmed", "settled"];

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
  // Corrections, cancellations and credit notes are first-class lifecycle
  // events (CORE-09): an adjustment must name a real, same-tenant, stamped
  // original; a plain invoice must not carry a relatedInvoiceId.
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
  let subtotal = 0;
  let vatTotal = 0;
  const computed = input.lines.map((l, idx) => {
    const fin = computeLineFinancials(l);
    subtotal += Number(fin.lineExtension);
    vatTotal += Number(fin.vatAmount);
    return { ...l, ...fin, lineNo: idx + 1 };
  });
  const grandTotal = subtotal + vatTotal;

  const [invoice] = await getDb()
    .insert(invoicesTable)
    .values({
      firmId: input.firmId,
      supplierPartyId: input.supplierPartyId,
      buyerPartyId: input.buyerPartyId,
      invoiceNumber: input.invoiceNumber,
      currency: input.currency ?? "NGN",
      issueDate: input.issueDate,
      dueDate: input.dueDate ?? null,
      kind: input.kind ?? "invoice",
      category: input.category ?? "b2b",
      relatedInvoiceId: input.relatedInvoiceId ?? null,
      notes: input.notes ?? null,
      subtotal: money(subtotal),
      vatTotal: money(vatTotal),
      grandTotal: money(grandTotal),
    })
    .returning();
  const lines = await getDb()
    .insert(invoiceLinesTable)
    .values(
      computed.map((c) => ({
        invoiceId: invoice.id,
        lineNo: c.lineNo,
        description: c.description,
        quantity: c.quantity,
        unitPrice: c.unitPrice,
        vatRate: c.vatRate,
        lineExtension: c.lineExtension,
        vatAmount: c.vatAmount,
      })),
    )
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
