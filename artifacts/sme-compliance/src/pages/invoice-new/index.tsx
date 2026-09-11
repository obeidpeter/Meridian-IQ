// The SME new-invoice page (R126 split the 985-line file into this shell,
// the form hook, one module per card and the pure helpers). The route
// (App.tsx) and the unit suite (invoice-new.test.tsx) keep importing
// "@/pages/invoice-new" / "./invoice-new": this module is the page's
// surface, so the draft-storage names and CURRENCIES are re-exported here.
import { PageHeader } from "@/components/page-header";
import { RequireClientScope } from "@/components/require-client-scope";
import { AddCustomerDialog } from "@/components/add-customer-dialog";
import { InvoiceDraftControls } from "@/components/invoice-draft-controls";
import { useInvoiceNewForm } from "./use-invoice-new-form";
import { SubmissionRecovery } from "./submission-recovery";
import { ClerkDraftCard } from "./clerk-draft-card";
import { InvoiceDetailsCard } from "./details-card";
import { InvoiceLinesCard } from "./lines-card";
import { ReadinessSummaryCard } from "./summary-card";

export { DRAFT_KEY, draftStorageKey } from "@/lib/invoice-draft";
export type { DraftState } from "@/lib/invoice-draft";
export { CURRENCIES } from "./helpers";

export function InvoiceNew() {
  const state = useInvoiceNewForm();
  const {
    drafts,
    draft,
    setDraft,
    submission,
    submitting,
    me,
    clerkLit,
    clerkText,
    setClerkText,
    clerkNote,
    clerkDraft,
    draftWithClerk,
    discardDraft,
    showErrors,
    addCustomerOpen,
    setAddCustomerOpen,
    frequentItems,
    addFrequentItem,
    tinGuidance,
    selectedBuyer,
    totals,
    errors,
    isValid,
    setLine,
    checklist,
    submit,
  } = state;
  const locked = !!submission;

  return (
    <div className="space-y-6">
      <PageHeader
        title="New invoice"
        description="Prepare the invoice details, then validate them before submitting."
      />
      <InvoiceDraftControls
        controller={drafts}
        disabled={submitting || (locked && submission.status !== "succeeded")}
        onDiscard={() => void discardDraft()}
      />
      {submission && (
        <SubmissionRecovery
          submission={submission}
          submitting={submitting}
          onSubmit={submit}
        />
      )}

      <RequireClientScope thing="invoice form">
        <AddCustomerDialog
          open={addCustomerOpen}
          onOpenChange={setAddCustomerOpen}
          onCreated={(party) =>
            setDraft((d) => ({ ...d, buyerPartyId: party.id }))
          }
        />
        <fieldset
          disabled={submitting || locked || drafts.state.status === "loading"}
          className="grid min-w-0 gap-6 lg:grid-cols-3"
        >
          <div className="lg:col-span-2 space-y-6">
            {clerkLit && (
              <ClerkDraftCard
                clerkText={clerkText}
                setClerkText={setClerkText}
                onDraft={draftWithClerk}
                pending={clerkDraft.isPending}
                note={clerkNote}
              />
            )}

            <InvoiceDetailsCard
              draft={draft}
              setDraft={setDraft}
              showErrors={showErrors}
              errors={errors}
              me={me}
              selectedBuyer={selectedBuyer}
              tinGuidance={tinGuidance}
              onAddCustomer={() => setAddCustomerOpen(true)}
            />

            <InvoiceLinesCard
              draft={draft}
              setDraft={setDraft}
              frequentItems={frequentItems}
              addFrequentItem={addFrequentItem}
              setLine={setLine}
              showErrors={showErrors}
              errors={errors}
            />
          </div>

          <div className="space-y-6">
            <ReadinessSummaryCard
              checklist={checklist}
              totals={totals}
              currency={draft.currency}
              submitting={submitting}
              conflict={drafts.state.status === "conflict"}
              onSubmit={submit}
              showErrors={showErrors}
              isValid={isValid}
            />
          </div>
        </fieldset>
      </RequireClientScope>
    </div>
  );
}
