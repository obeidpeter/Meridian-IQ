import type { InvoiceAbilities } from "./abilities";
import type { InvoiceDetailState } from "./use-invoice-detail";
import type { InvoiceTab } from "./workspace-tabs";

export function invoiceWorkspaceIssues(
  state: InvoiceDetailState,
  abilities: InvoiceAbilities,
) {
  const issues: Partial<Record<InvoiceTab, string>> = {};
  if (
    state.tone === "failed" ||
    state.validationErrors.length > 0 ||
    state.fixConflict
  ) {
    issues.overview = "Invoice issues need review.";
  }
  if (state.stampedFamily && state.stampQuery.isError) {
    issues.documents = "The stamp record could not be loaded.";
  }
  if (
    state.approvalsQuery.isError ||
    (!abilities.confirmationsDark && state.confirmationsQuery.isError)
  ) {
    issues.approvals =
      "Approval or buyer confirmation records could not be loaded.";
  }
  if (state.settlementsQuery.isError) {
    issues.payments = "Recorded payments could not be loaded.";
  }
  if (state.attemptsQuery.isError || state.escalationsQuery.isError) {
    issues.history = "Submission or escalation history could not be loaded.";
  }
  return issues;
}
