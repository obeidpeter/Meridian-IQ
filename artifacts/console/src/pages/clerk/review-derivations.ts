import type { ClerkCase } from "@workspace/api-client-react";
import {
  type ApproveForm,
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
