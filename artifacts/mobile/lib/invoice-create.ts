/**
 * Pure helpers behind the create-invoice tab: fresh line keys (one counter
 * shared with the voice-draft prefix so keys can never collide), the
 * server field-path labels, the local pre-flight check and the create
 * payload. The idempotent create sequence itself stays in the route file.
 */

import {
  InvoiceInputCategory,
  InvoiceInputKind,
} from "@workspace/api-client-react";
import type {
  InvoiceInput,
  InvoiceLineInput,
} from "@workspace/api-client-react";

import { blankLine, parseNumeric } from "./invoice-form";
import type { LineDraft } from "./invoice-form";

let lineCounter = 0;
export function newLine(): LineDraft {
  lineCounter += 1;
  return blankLine(`line-${Date.now()}-${lineCounter}`);
}

/**
 * The key prefix for one voice-drafted batch of lines. It bumps the SAME
 * counter newLine() uses, so a manual line added after a voice draft can
 * never reuse a key.
 */
export function nextVoiceKeyPrefix(): string {
  lineCounter += 1;
  return `voice-${lineCounter}-`;
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

// Turn a server field path (e.g. "lines.0.unitPrice") into a human label
// (e.g. "Line 1 · Unit price").
const FIELD_LABELS: Record<string, string> = {
  unitPrice: "Unit price",
  quantity: "Quantity",
  vatRate: "VAT rate",
  description: "Description",
  invoiceNumber: "Invoice number",
  issueDate: "Issue date",
  dueDate: "Due date",
  buyerPartyId: "Buyer",
  supplierPartyId: "Supplier",
  notes: "Notes",
};
function humanizeKey(key: string): string {
  const last = key.split(".").pop() ?? key;
  return (
    FIELD_LABELS[last] ??
    last.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase())
  );
}
export function humanizeFieldPath(path: string): string {
  const lineMatch = path.match(/^lines\.(\d+)\.(.+)$/);
  if (lineMatch) {
    return `Line ${Number(lineMatch[1]) + 1} · ${humanizeKey(lineMatch[2])}`;
  }
  return humanizeKey(path);
}

/**
 * The local pre-flight check, in the order the banner reports it; null when
 * the form may go to the server. `buyerSelected` is the picker's verified
 * selection — a chosen ID alone is not enough.
 */
export function localInvoiceError({
  clientPartyId,
  buyerPartyId,
  buyerSelected,
  invoiceNumber,
  issueDate,
  lines,
}: {
  clientPartyId: string | null;
  buyerPartyId: string | null;
  buyerSelected: boolean;
  invoiceNumber: string;
  issueDate: string;
  lines: LineDraft[];
}): string | null {
  if (!clientPartyId) return "No client selected.";
  if (!buyerPartyId) return "Choose a buyer for this invoice.";
  if (!buyerSelected)
    return "Verify the selected buyer or choose an available buyer.";
  if (!invoiceNumber.trim()) return "Enter an invoice number.";
  if (!issueDate.trim()) return "Enter an issue date.";
  const hasValidLine = lines.some((l) => {
    const price = parseNumeric(l.unitPrice);
    return l.description.trim() !== "" && price !== null && price > 0;
  });
  if (!hasValidLine)
    return "Add at least one line item with a description and price.";
  return null;
}

/** The create payload: a B2B invoice with trimmed fields and optional notes. */
export function buildInvoicePayload({
  clientPartyId,
  buyerPartyId,
  invoiceNumber,
  issueDate,
  notes,
  payloadLines,
}: {
  clientPartyId: string;
  buyerPartyId: string;
  invoiceNumber: string;
  issueDate: string;
  notes: string;
  payloadLines: InvoiceLineInput[];
}): InvoiceInput {
  return {
    supplierPartyId: clientPartyId,
    buyerPartyId,
    invoiceNumber: invoiceNumber.trim(),
    issueDate: issueDate.trim(),
    kind: InvoiceInputKind.invoice,
    category: InvoiceInputCategory.b2b,
    notes: notes.trim() || undefined,
    lines: payloadLines,
  };
}
