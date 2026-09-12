// The SME invoice detail page (R120 split the 2,157-line file into this
// shell, one module per card, the adjust dialog, the status meta and the
// pure helpers; R126 moved the queries, mutations, state and handlers into
// use-invoice-detail.ts and the page blocks into their own modules). The
// route (App.tsx), the unit suites (invoice-detail.test.tsx,
// invoice-detail-shell.test.tsx) keep importing "@/pages/invoice-detail" /
// "./invoice-detail": this module is the page's surface.

import { errorStatus } from "@/lib/errors";
import { useUrlTab } from "@workspace/web-ui";
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
import {
  ApprovalsPanel,
  DocumentsPanel,
  HistoryPanel,
  PaymentsPanel,
} from "./workspace-panels";
import { INVOICE_TABS, WorkspaceTabs, type InvoiceTab } from "./workspace-tabs";
import { NextAction } from "./next-action";
import { WorkspaceSummary } from "./workspace-summary";
import { invoiceWorkspaceIssues } from "./workspace-issues";

export function InvoiceDetail() {
  const detail = useInvoiceDetail();
  const [tab, setTab] = useUrlTab<InvoiceTab>("tab", "overview", INVOICE_TABS);
  const state = {
    ...detail,
    openFix: () => {
      setTab("overview");
      detail.openFix();
    },
  };
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
    <div className="min-w-0 space-y-6">
      <BackToVault />

      <div className="flex flex-wrap items-start justify-between gap-4">
        <DetailHeader invoice={invoice} />
        <DetailActions state={state} invoice={invoice} abilities={abilities} />
      </div>

      <NextAction
        state={state}
        invoice={invoice}
        abilities={abilities}
        onTabChange={setTab}
      />

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

      <WorkspaceTabs
        value={tab}
        onChange={setTab}
        issues={invoiceWorkspaceIssues(state, abilities)}
        panels={{
          overview: (
            <>
              <WorkspaceSummary state={state} invoice={invoice} />
              <StatusSection state={state} />
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
                showFixButton={!fix && abilities.canSubmit}
              />

              {tone !== "failed" && fixForm && (
                <EditInvoiceCard fixForm={fixForm} />
              )}

              <LineItemsCard invoice={invoice} data={data} />
            </>
          ),
          documents: (
            <DocumentsPanel
              state={state}
              invoice={invoice}
              abilities={abilities}
            />
          ),
          approvals: (
            <ApprovalsPanel
              state={state}
              invoice={invoice}
              abilities={abilities}
            />
          ),
          payments: (
            <PaymentsPanel
              state={state}
              invoice={invoice}
              abilities={abilities}
            />
          ),
          history: (
            <HistoryPanel
              state={state}
              invoice={invoice}
              abilities={abilities}
            />
          ),
        }}
      />
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
