// The SME invoice detail page (R120 split the 2,157-line file into this
// shell, one module per card, the adjust dialog, the status meta and the
// pure helpers; R126 moved the queries, mutations, state and handlers into
// use-invoice-detail.ts and the page blocks into their own modules). The
// route (App.tsx), the unit suites (invoice-detail.test.tsx,
// invoice-detail-shell.test.tsx) keep importing "@/pages/invoice-detail" /
// "./invoice-detail": this module is the page's surface.

import { errorStatus } from "@/lib/errors";
import { ValidationErrorsCard } from "./validation-errors-card";
import { AdjustDialog } from "./adjust-dialog";
import { invoiceAbilities } from "./abilities";
import { useInvoiceDetail } from "./use-invoice-detail";
import {
  BackToVault,
  DetailLoadError,
  DetailSkeleton,
  UnknownInvoice,
} from "./page-states";
import { DetailActions, DetailHeader } from "./header";
import { NewFromDraftDialog, SubmitConfirmDialog } from "./confirm-dialogs";
import { StatusSection } from "./status-section";
import { SubmissionFailedCard } from "./failure-card";
import { ConnectedFixForm, EditInvoiceCard } from "./edit-card";
import { LineItemsCard } from "./line-items-card";
import { TrailSection } from "./trail-section";

export function InvoiceDetail() {
  const state = useInvoiceDetail();
  const {
    isLoading,
    isError,
    error,
    refetch,
    invoice,
    data,
    tone,
    fix,
    openFix,
    validationErrors,
    adjustKind,
    adjustReason,
    setAdjustReason,
    closeAdjust,
    handleAdjust,
    cancelInvoice,
    creditNote,
  } = state;

  if (isLoading) {
    return <DetailSkeleton />;
  }

  if (isError && errorStatus(error) !== 404) {
    return <DetailLoadError onRetry={() => refetch()} />;
  }

  if (isError || !invoice) {
    return <UnknownInvoice />;
  }

  const abilities = invoiceAbilities({
    invoice,
    me: state.me,
    errorCode: state.errorCode,
    confirmations: state.confirmations,
    confirmationsError: state.confirmationsError,
  });

  const fixForm = fix ? (
    <ConnectedFixForm state={state} invoice={invoice} abilities={abilities} />
  ) : null;

  return (
    <div className="space-y-6">
      <BackToVault />

      <div className="flex flex-wrap items-start justify-between gap-4">
        <DetailHeader invoice={invoice} />
        <DetailActions state={state} invoice={invoice} abilities={abilities} />
      </div>

      <SubmitConfirmDialog state={state} invoice={invoice} />

      <NewFromDraftDialog state={state} invoice={invoice} />

      <AdjustDialog
        kind={adjustKind}
        reason={adjustReason}
        onReasonChange={setAdjustReason}
        onClose={closeAdjust}
        onConfirm={handleAdjust}
        isPending={cancelInvoice.isPending || creditNote.isPending}
      />

      <StatusSection state={state} invoice={invoice} abilities={abilities} />

      {tone === "failed" && (
        <SubmissionFailedCard
          state={state}
          abilities={abilities}
          fixForm={fixForm}
        />
      )}

      <ValidationErrorsCard
        errors={validationErrors}
        onFix={openFix}
        showFixButton={!fix}
      />

      {tone !== "failed" && fixForm && <EditInvoiceCard fixForm={fixForm} />}

      <LineItemsCard invoice={invoice} data={data} />

      <TrailSection state={state} invoice={invoice} abilities={abilities} />
    </div>
  );
}

// The unit suite pins these through this module, so the split keeps the
// page's import path as its surface.
export { PaymentReminderCard } from "./payment-reminder-card";
export { ValidationErrorsCard } from "./validation-errors-card";
export { submitErrorTitle, submittedToastDescription } from "./helpers";
export {
  ApprovalsCard,
  canApproveInvoice,
} from "@/components/invoice-approvals";
