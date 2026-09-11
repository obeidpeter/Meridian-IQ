// The SME reconciliation page (R126 split the 1,105-line file into this
// shell, the state hook, one module per section and the pure helpers). The
// route (App.tsx) and the unit suite (reconciliation.test.tsx) keep importing
// "@/pages/reconciliation" / "./reconciliation": this module is the page's
// surface, so the pure helpers are re-exported here.
import { PageHeader } from "@/components/page-header";
import { FeatureUnavailable } from "@/components/feature-unavailable";
import { RequireClientScope } from "@/components/require-client-scope";
import { ClerkDisabledBanner } from "@/components/clerk-disabled-banner";
import { isFeatureDisabled } from "@/lib/errors";
import { useReconciliation } from "./use-reconciliation";
import { StatementImportSection } from "./statement-import-section";
import { StatementsCard } from "./statements-card";
import { ProposalsCard } from "./proposals-card";

export {
  narrationCueLabel,
  narrationChipFor,
  narrationSuggestVisible,
  narrationSummaryLine,
  statementImportBody,
} from "./helpers";

export function Reconciliation() {
  const state = useReconciliation();
  const {
    statementsError,
    clerkDown,
    narrationDown,
    csv,
    editCsv,
    filename,
    pdf,
    csvLines,
    onFile,
    run,
    importMut,
    report,
    reportSource,
    statements,
    statementsLoading,
    statementsIsError,
    refetchStatements,
    selectedId,
    setSelectedId,
    selectedStatement,
    proposals,
    proposalsLoading,
    proposalsIsError,
    refetchProposals,
    linesById,
    bulkEligibleCount,
    bulkArmed,
    bulkAccept,
    runBulkAccept,
    showNarrationSuggest,
    narrationMut,
    runNarrationSuggest,
    narrationSummary,
    decidingId,
    assistingId,
    assistById,
    decide,
    explainMatch,
  } = state;

  if (isFeatureDisabled(statementsError)) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Reconciliation"
          description="Match bank-statement lines to your stamped invoices."
        />
        <FeatureUnavailable feature="Reconciliation" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reconciliation"
        description="Upload a bank statement to find possible invoice matches for incoming payments."
      />

      <RequireClientScope thing="reconciliation workspace">
        <div className="space-y-6">
          {clerkDown && (
            <ClerkDisabledBanner>
              Scanned-statement reading is paused. Upload your bank&apos;s CSV
              export instead, or try the PDF again later.
            </ClerkDisabledBanner>
          )}

          {narrationDown && (
            <ClerkDisabledBanner>
              Narration reading is paused — matching stays manual. Accept or
              reject the proposals yourself, or try again later.
            </ClerkDisabledBanner>
          )}

          <StatementImportSection
            csv={csv}
            editCsv={editCsv}
            filename={filename}
            pdf={pdf}
            csvLines={csvLines}
            onFile={onFile}
            run={run}
            importMut={importMut}
            report={report}
            reportSource={reportSource}
          />

          <StatementsCard
            statements={statements}
            statementsLoading={statementsLoading}
            statementsIsError={statementsIsError}
            refetchStatements={refetchStatements}
            selectedId={selectedId}
            setSelectedId={setSelectedId}
          />

          {selectedId && (
            <ProposalsCard
              selectedId={selectedId}
              selectedStatement={selectedStatement}
              bulkEligibleCount={bulkEligibleCount}
              showNarrationSuggest={showNarrationSuggest}
              runBulkAccept={runBulkAccept}
              bulkAccept={bulkAccept}
              decidingId={decidingId}
              bulkArmed={bulkArmed}
              runNarrationSuggest={runNarrationSuggest}
              narrationMut={narrationMut}
              narrationSummary={narrationSummary}
              proposals={proposals}
              proposalsLoading={proposalsLoading}
              proposalsIsError={proposalsIsError}
              refetchProposals={refetchProposals}
              linesById={linesById}
              assistingId={assistingId}
              assistById={assistById}
              decide={decide}
              explainMatch={explainMatch}
            />
          )}
        </div>
      </RequireClientScope>
    </div>
  );
}
