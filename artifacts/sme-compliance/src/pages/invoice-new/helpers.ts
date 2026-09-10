// Pure helpers for the SME new-invoice page (R126 split): the currency list
// and the "No WHT" sentinel, the draft's validation errors and the field ids
// they point at, the first-invalid-field focus, the create-invoice request
// body and the readiness rail. No React, no hooks.
import type {
  createInvoice,
  InvoiceInputWhtCategory,
  InvoiceLineInput,
  Party,
} from "@workspace/api-client-react";
import type { ReadinessStep } from "@workspace/web-ui";
import type { DraftState } from "@/lib/invoice-draft";
import { invoiceLineErrors } from "@/lib/invoice-lines";

// The lawful set the rails accept for e-invoicing; NGN leads and is the
// default — a foreign currency additionally wants an exchange rate so the
// naira-equivalent VAT can be computed server-side.
export const CURRENCIES = ["NGN", "USD", "EUR", "GBP"] as const;

// The Radix select can't carry an empty-string item value, so the "No WHT"
// option rides a sentinel that maps back to "" in the draft.
export const NO_WHT = "none";

/** The draft's validation errors, keyed by field (line-N-desc / -qty / -price). */
export function draftErrors(draft: DraftState): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!draft.invoiceNumber.trim())
    errors.invoiceNumber = "Invoice number is required.";
  if (!draft.buyerPartyId) errors.buyerPartyId = "Select a customer.";
  // A missing buyer TIN never blocks a DRAFT — the note under the picker
  // warns, the checklist stays unchecked, and the server refuses submission
  // for stamping until the TIN exists (canonical validation).
  if (!draft.issueDate) errors.issueDate = "Issue date is required.";
  draft.lines.forEach((l, i) => {
    const lineErrors = invoiceLineErrors(l);
    if (lineErrors.description)
      errors[`line-${i}-desc`] = lineErrors.description;
    if (lineErrors.quantity) errors[`line-${i}-qty`] = lineErrors.quantity;
    if (lineErrors.unitPrice) errors[`line-${i}-price`] = lineErrors.unitPrice;
  });
  return errors;
}

// Which DOM element carries each validation error, in visual order — used to
// scroll/focus the first invalid field on a failed submit.
export function errorFieldIdsFor(
  draft: DraftState,
  errors: Record<string, string>,
): string[] {
  const ids: string[] = [];
  if (errors.invoiceNumber) ids.push("invoice-number");
  if (errors.buyerPartyId) ids.push("buyer-select");
  if (errors.issueDate) ids.push("issue-date");
  draft.lines.forEach((_, i) => {
    if (errors[`line-${i}-desc`]) ids.push(`line-${i}-description`);
    if (errors[`line-${i}-qty`]) ids.push(`line-${i}-quantity`);
    if (errors[`line-${i}-price`]) ids.push(`line-${i}-unit-price`);
  });
  return ids;
}

/** Scroll to and focus the first of the invalid fields, if any. */
export function focusFirstInvalidField(ids: string[]) {
  const first = ids[0];
  if (first) {
    const el = document.getElementById(first);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    (el as HTMLElement | null)?.focus({ preventScroll: true });
  }
}

/**
 * The create-invoice request body for a draft. Empty optional fields are
 * omitted, never sent as "" — the suite records the body byte for byte.
 */
export function invoiceInputFromDraft(
  draft: DraftState,
  supplierPartyId: string,
  lines: InvoiceLineInput[],
): Parameters<typeof createInvoice>[0] {
  const fxRate = draft.fxRateToNgn.trim();
  return {
    supplierPartyId,
    buyerPartyId: draft.buyerPartyId,
    invoiceNumber: draft.invoiceNumber.trim(),
    currency: draft.currency || "NGN",
    // The rate only makes sense on a foreign-currency invoice, and an
    // empty field is omitted, never sent as "".
    ...(draft.currency !== "NGN" && fxRate ? { fxRateToNgn: fxRate } : {}),
    issueDate: draft.issueDate,
    dueDate: draft.dueDate || undefined,
    // Only a real, human-picked category travels; "" (No WHT) is
    // omitted, never sent.
    ...(draft.whtCategory
      ? {
          whtCategory: draft.whtCategory as InvoiceInputWhtCategory,
        }
      : {}),
    lines,
  };
}

// The guided rail (R70): each step names its form section, links to it,
// and says what is still missing. The TIN row is "attention", never
// blocking — a draft without a buyer TIN is lawful; stamping is not.
export function readinessSteps(
  draft: DraftState,
  selectedBuyer: Pick<Party, "tin"> | undefined,
): ReadinessStep[] {
  const linesComplete =
    draft.lines.length > 0 &&
    draft.lines.every(
      (line) => Object.keys(invoiceLineErrors(line)).length === 0,
    );
  const vatLawful = draft.lines.every(
    (l) => Number(l.vatRate) === 0.075 || Number(l.vatRate) === 0,
  );
  return [
    {
      id: "invoice-number",
      label: "Invoice number",
      state: draft.invoiceNumber.trim() ? "done" : "todo",
      href: "#invoice-details",
    },
    {
      id: "customer",
      label: "Customer selected",
      state: draft.buyerPartyId ? "done" : "todo",
      href: "#invoice-details",
    },
    {
      id: "customer-tin",
      label: "Customer has a TIN",
      state: selectedBuyer?.tin
        ? "done"
        : draft.buyerPartyId
          ? "attention"
          : "todo",
      href: "#invoice-details",
      detail:
        draft.buyerPartyId && !selectedBuyer?.tin
          ? "Needed before stamping; a draft can still be saved."
          : undefined,
    },
    {
      id: "line-items",
      label: "Line items complete",
      state: linesComplete ? "done" : "todo",
      href: "#invoice-lines",
      detail: linesComplete
        ? undefined
        : "Every line needs a description, a quantity above zero and a valid unit price. Zero-priced items are allowed.",
    },
    {
      id: "vat",
      label: "VAT at 7.5% (or exempt)",
      state: vatLawful ? "done" : "attention",
      href: "#invoice-lines",
    },
  ];
}
