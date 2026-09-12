import type { ClerkCase } from "@workspace/api-client-react";
import {
  type ApproveForm,
  type NoticeApproveForm,
  fieldLabel,
  noticeFieldLabel,
  vatPercentInvalid,
} from "@/pages/clerk-shared";

// The review pane's pure derivations (R126 lifted them out of the workspace
// hook): whether the invoice form can be approved as it stands, and the
// fields-table inputs for the selected case.

export function approveDisabledFor(form: ApproveForm | null): boolean {
  return (
    !form ||
    !form.firmId ||
    !form.supplierPartyId ||
    !form.buyerPartyId ||
    !form.invoiceNumber.trim() ||
    !form.issueDate ||
    form.lines.length === 0 ||
    form.lines.some(
      (l) =>
        !l.description.trim() ||
        !l.quantity ||
        !l.unitPrice ||
        vatPercentInvalid(l.vatRate),
    )
  );
}

export function fieldsNeedingReview(
  selected: ClerkCase,
  form: ApproveForm | null,
  noticeForm: NoticeApproveForm | null,
): string[] {
  if (selected.status !== "extracted" && selected.status !== "in_review")
    return [];
  const { detailExtraction, activePreflight } = reviewPaneFields(selected);
  const fields = new Set<string>();
  for (const field of detailExtraction?.fields ?? []) {
    if (
      field.flagged ||
      (field.critical && (field.confidence < 0.9 || !field.value?.trim()))
    )
      fields.add(field.field);
  }
  for (const issue of activePreflight) fields.add(issue.field);
  if (form) {
    for (const field of [
      "firmId",
      "supplierPartyId",
      "buyerPartyId",
      "invoiceNumber",
      "issueDate",
    ] as const) {
      if (!form[field].trim()) fields.add(field);
    }
    if (form.lines.length === 0) fields.add("lines");
    form.lines.forEach((line, index) => {
      for (const field of [
        "description",
        "quantity",
        "unitPrice",
        "vatRate",
      ] as const) {
        if (
          field === "vatRate"
            ? vatPercentInvalid(line[field])
            : !line[field].trim()
        )
          fields.add(`lines.${index}.${field}`);
      }
    });
  }
  if (noticeForm) {
    for (const field of [
      "firmId",
      "clientPartyId",
      "noticeType",
      "authority",
      "responseDueDate",
    ] as const) {
      if (!noticeForm[field]) fields.add(field);
    }
  }
  return [...fields];
}

const INVOICE_CONTROLS: Record<string, string> = {
  firmId: "select-firm-control",
  supplierPartyId: "select-supplier-control",
  supplierName: "select-supplier-control",
  supplierTin: "select-supplier-control",
  buyerPartyId: "select-buyer-control",
  buyerName: "select-buyer-control",
  buyerTin: "select-buyer-control",
  invoiceNumber: "apr-number",
  issueDate: "apr-issue",
  dueDate: "apr-due",
  currency: "apr-currency",
  category: "apr-category",
  lines: "apr-lines",
  subtotal: "apr-lines",
  vatTotal: "apr-lines",
  grandTotal: "apr-lines",
};
const NOTICE_CONTROLS: Record<string, string> = {
  firmId: "select-notice-firm-control",
  clientPartyId: "select-notice-client-control",
  taxpayerName: "select-notice-client-control",
  taxpayerTin: "select-notice-client-control",
  tin: "select-notice-client-control",
  noticeType: "select-notice-type-control",
  authority: "select-notice-authority-control",
  taxType: "select-notice-tax-type-control",
  referenceNumber: "ntc-reference",
  reference: "ntc-reference",
  amountDemanded: "ntc-amount",
  amount: "ntc-amount",
  period: "ntc-period",
  currency: "ntc-currency",
  issueDate: "ntc-issue",
  responseDueDate: "ntc-due",
  notes: "ntc-notes",
};

export function reviewControlId(
  kind: ClerkCase["kind"],
  field: string,
): string | undefined {
  if (kind === "notice") return NOTICE_CONTROLS[field];
  const line = /^lines\.(\d+)\.(description|quantity|unitPrice|vatRate)$/.exec(
    field,
  );
  if (line) return `apr-line-${line[1]}-${line[2]}`;
  if (field.startsWith("lines.")) return "apr-lines";
  return INVOICE_CONTROLS[field];
}

export function reviewTargetLabel(
  kind: ClerkCase["kind"],
  field: string,
): string {
  const labels: Record<string, string> = {
    firmId: "Firm",
    supplierPartyId: "Supplier",
    buyerPartyId: "Customer",
    clientPartyId: "Client",
    lines: "Invoice items",
  };
  const line = /^lines\.(\d+)\.(.+)$/.exec(field);
  if (line)
    return `Line ${Number(line[1]) + 1} ${fieldLabel(line[2]).toLowerCase()}`;
  return (
    labels[field] ??
    (kind === "notice" ? noticeFieldLabel(field) : fieldLabel(field))
  );
}

export function reviewPaneFields(selected: ClerkCase | undefined) {
  // The review pane's fields table serves both case kinds: an invoice case
  // carries `extraction`, a notice case carries `noticeExtraction` — same
  // field shape (value/confidence/flagged/critical/snippet), same
  // presentation, different label vocabulary. Correction hints stay
  // invoice-only: the corrections exhaust is invoice-field evidence.
  const detailExtraction =
    selected?.extraction ?? selected?.noticeExtraction ?? null;
  const detailFieldLabel =
    selected?.kind === "notice" ? noticeFieldLabel : fieldLabel;

  // Pre-flight issues only steer the review while the case is still
  // decidable; decided cases keep their history without the amber paint.
  const activePreflight =
    selected != null &&
    (selected.status === "extracted" || selected.status === "in_review")
      ? (selected.preflight ?? [])
      : [];
  const preflightFields = new Set(activePreflight.map((i) => i.field));
  // "lines" / "lines.0.quantity" style issues point at the lines table as a
  // whole — per-cell targeting isn't worth the noise.
  const linesPreflightHit = activePreflight.some(
    (i) => i.field === "lines" || i.field.startsWith("lines."),
  );

  return {
    detailExtraction,
    detailFieldLabel,
    activePreflight,
    preflightFields,
    linesPreflightHit,
  };
}
