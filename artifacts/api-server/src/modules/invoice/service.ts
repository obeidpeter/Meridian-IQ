import { asc, eq } from "drizzle-orm";
import {
  getDb,
  invoicesTable,
  invoiceLinesTable,
  partiesTable,
  outboxTable,
  type Invoice,
  type InvoiceLine,
} from "@workspace/db";
import { DomainError } from "../errors";
import { appendAudit } from "../audit/audit";
import { isPurposePermitted } from "../consent/consent";
import { assertTransition, recordTransition } from "./lifecycle";
import {
  validateCanonical,
  type CanonicalInvoice,
  type FieldError,
} from "./canonical";

export interface LineInput {
  description: string;
  quantity: string;
  unitPrice: string;
  vatRate: string; // fraction, e.g. "0.075"
}

function money(n: number): string {
  return n.toFixed(2);
}

// Compute line + document financials from raw inputs.
export function computeLineFinancials(line: LineInput) {
  const qty = Number(line.quantity);
  const price = Number(line.unitPrice);
  const rate = Number(line.vatRate);
  const lineExtension = qty * price;
  const vatAmount = lineExtension * rate;
  return {
    lineExtension: money(lineExtension),
    vatAmount: money(vatAmount),
  };
}

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

export async function createDraft(
  input: CreateInvoiceInput,
  actorId?: string,
): Promise<{ invoice: Invoice; lines: InvoiceLine[] }> {
  if (input.lines.length === 0) {
    throw new DomainError("NO_LINES", "An invoice needs at least one line", 400);
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
  assertTransition(bundle.invoice.status, "validated");
  await getDb()
    .update(invoicesTable)
    .set({ status: "validated" })
    .where(eq(invoicesTable.id, invoiceId));
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
  assertTransition(bundle.invoice.status, "submitted");
  const [updated] = await getDb()
    .update(invoicesTable)
    .set({ status: "submitted" })
    .where(eq(invoicesTable.id, invoiceId))
    .returning();
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
