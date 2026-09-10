/**
 * Pure helpers behind the fix-invoice screen: which sections a rail error
 * implicates, the party draft/patch model, the editability and dirty
 * predicates, the pre-save form check and the invoice PATCH builder. All
 * Node-safe, so lib/fix-invoice.test.ts characterises the save contract
 * (party fixes before the invoice PATCH, null-clearing, the linesDirty
 * gating) without rendering the screen.
 */

import type {
  Invoice,
  InvoiceDetail,
  InvoiceLineInput,
  Party,
} from "@workspace/api-client-react";

import { isValidISODate, normalizeLines } from "./invoice-form";
import type { LineDraft, LineErrors } from "./invoice-form";

// Which sections a rail error implicates, so the fix flow can point the user
// at the right fields instead of leaving them to guess.
export type FocusArea = "parties" | "invoice" | "lines" | "invoiceNumber";
export const ERROR_FOCUS: Record<string, FocusArea[]> = {
  MBS_INVALID_TIN: ["parties"],
  MBS_SCHEMA_INVALID: ["invoice", "lines"],
  MBS_DUPLICATE: ["invoiceNumber"],
};

export function focusAreasFor(code: string): FocusArea[] {
  return ERROR_FOCUS[code] ?? [];
}

export interface PartyDraft {
  legalName: string;
  tin: string;
  cacNumber: string;
  street: string;
  city: string;
}

export function partyToDraft(p: Party): PartyDraft {
  return {
    legalName: p.legalName ?? "",
    tin: p.tin ?? "",
    cacNumber: p.cacNumber ?? "",
    street: p.street ?? "",
    city: p.city ?? "",
  };
}

export function partyPatch(draft: PartyDraft, original: Party) {
  const patch: Record<string, string | null> = {};
  if (draft.legalName.trim() && draft.legalName.trim() !== original.legalName) {
    patch.legalName = draft.legalName.trim();
  }
  const tin = draft.tin.trim();
  if (tin !== (original.tin ?? "")) patch.tin = tin === "" ? null : tin;
  const cac = draft.cacNumber.trim();
  if (cac !== (original.cacNumber ?? "")) {
    patch.cacNumber = cac === "" ? null : cac;
  }
  const street = draft.street.trim();
  if (street !== (original.street ?? "")) {
    patch.street = street === "" ? null : street;
  }
  const city = draft.city.trim();
  if (city !== (original.city ?? "")) patch.city = city === "" ? null : city;
  return patch;
}

/** An editable party draft that differs from what the server holds. */
export function partyDraftDirty(
  locked: boolean,
  draft: PartyDraft | null,
  original: Party | undefined,
): boolean {
  return (
    !locked &&
    !!draft &&
    !!original &&
    Object.keys(partyPatch(draft, original)).length > 0
  );
}

// The server is the authority on editability: submitted/stamped/terminal
// invoices are content-frozen (the PATCH would 409). Mirror that here so the
// user is told up-front instead of hitting a dead end on save.
export function isContentEditable(invoice: Invoice | undefined): boolean {
  return (
    !invoice ||
    invoice.status === "draft" ||
    invoice.status === "validated" ||
    invoice.status === "failed"
  );
}

/** The saved lines as editable drafts, keyed by their server IDs. */
export function linesFromDetail(lines: InvoiceDetail["lines"]): LineDraft[] {
  return lines.map((l) => ({
    key: l.id,
    description: l.description,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    // API stores VAT as a fraction (0.075); the form edits a percent.
    vatRate: String(Number(l.vatRate) * 100),
  }));
}

export interface InvoiceFields {
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  notes: string;
}

/** Any typed change to the invoice's own fields (trimmed, null-as-empty). */
export function invoiceFieldsDirty(
  invoice: Invoice | undefined,
  { invoiceNumber, issueDate, dueDate, notes }: InvoiceFields,
): boolean {
  return (
    !!invoice &&
    (invoiceNumber.trim() !== invoice.invoiceNumber ||
      issueDate.trim() !== invoice.issueDate ||
      dueDate.trim() !== (invoice.dueDate ?? "") ||
      notes.trim() !== (invoice.notes ?? ""))
  );
}

export interface FixFormCheck {
  ok: boolean;
  banner: string | null;
  issueDateError: string | null;
  dueDateError: string | null;
  lineErrors: LineErrors;
  payloadLines: InvoiceLineInput[];
}

const blocked = (banner: string): FixFormCheck => ({
  ok: false,
  banner,
  issueDateError: null,
  dueDateError: null,
  lineErrors: {},
  payloadLines: [],
});

/**
 * The pre-save check, in the order the screen reports it: the required
 * fields first (one banner, no inline errors), then the line count, then
 * every inline date/numeric error at once under one banner. Line errors —
 * and the "any lines left?" rule — only apply once the lines were edited:
 * a pristine prefill must stay saveable however its numerics parse.
 */
export function checkFixForm({
  invoiceNumber,
  issueDate,
  dueDate,
  lines,
  linesDirty,
}: {
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  lines: LineDraft[];
  linesDirty: boolean;
}): FixFormCheck {
  if (!invoiceNumber.trim()) return blocked("Enter an invoice number.");
  if (!issueDate.trim()) return blocked("Enter an issue date.");
  // Normalize the submitted lines' numerics (comma→dot), flagging anything
  // non-finite/empty as an inline error. normalizeLines is pure and emits
  // exactly one payload line per description-bearing draft line, so its
  // payload length doubles as the "any lines left?" check.
  const { payloadLines, lineErrs } = normalizeLines(lines);
  if (linesDirty && payloadLines.length === 0) {
    return blocked("Keep at least one line item with a description.");
  }

  // Inline date + numeric validation before any network call.
  let hasFieldError = false;
  let issueDateError: string | null = null;
  let dueDateError: string | null = null;
  let lineErrors: LineErrors = {};
  if (!isValidISODate(issueDate.trim())) {
    issueDateError = "Enter the issue date as YYYY-MM-DD.";
    hasFieldError = true;
  }
  if (dueDate.trim() && !isValidISODate(dueDate.trim())) {
    dueDateError = "Enter the due date as YYYY-MM-DD.";
    hasFieldError = true;
  }
  if (linesDirty && Object.keys(lineErrs).length > 0) {
    lineErrors = lineErrs;
    hasFieldError = true;
  }
  return {
    ok: !hasFieldError,
    banner: hasFieldError ? "Fix the highlighted fields before saving." : null,
    issueDateError,
    dueDateError,
    lineErrors,
    payloadLines,
  };
}

export interface InvoicePatch {
  invoiceNumber?: string;
  issueDate?: string;
  dueDate?: string | null;
  notes?: string | null;
  lines?: InvoiceLineInput[];
}

/**
 * The invoice PATCH: only the fields that changed, with an emptied optional
 * field sent as null so the server clears it, and the lines only when they
 * were edited.
 */
export function invoicePatchFor(
  invoice: Invoice,
  { invoiceNumber, issueDate, dueDate, notes }: InvoiceFields,
  linesDirty: boolean,
  payloadLines: InvoiceLineInput[],
): InvoicePatch {
  const invPatch: InvoicePatch = {};
  if (invoiceNumber.trim() !== invoice.invoiceNumber) {
    invPatch.invoiceNumber = invoiceNumber.trim();
  }
  if (issueDate.trim() !== invoice.issueDate) {
    invPatch.issueDate = issueDate.trim();
  }
  if (dueDate.trim() !== (invoice.dueDate ?? "")) {
    invPatch.dueDate = dueDate.trim() === "" ? null : dueDate.trim();
  }
  if (notes.trim() !== (invoice.notes ?? "")) {
    invPatch.notes = notes.trim() === "" ? null : notes.trim();
  }
  if (linesDirty) {
    invPatch.lines = payloadLines;
  }
  return invPatch;
}
