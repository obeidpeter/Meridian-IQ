// The SME bulk-import page (R126 split the 1,040-line file into this shell,
// the run hook, the run-flow stages, one module per card and the pure
// helpers). The route (App.tsx) and the unit suite (import.test.tsx) keep
// importing "@/pages/import" / "./import": this module is the page's
// surface and `Import` its only export.
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/page-header";
import { RequireClientScope } from "@/components/require-client-scope";
import { useImportRun } from "./use-import-run";
import { AddRowsCard } from "./add-rows-card";
import {
  CommitInterruptedAlert,
  ImportRunStatus,
  SkipInvalidDialog,
  ValidateStep,
} from "./import-controls";
import { ImportResultsCard } from "./results-card";

export function Import() {
  const state = useImportRun();
  const {
    importScope,
    readyScope,
    rows,
    overCap,
    duplicateNumbers,
    raw,
    editRaw,
    fileName,
    filePicker,
    importMut,
    activeRun,
    progress,
    recoverySaved,
    startNewImport,
    run,
    result,
    knownInvalidCount,
    confirmCommit,
    setConfirmCommit,
    onCommitClick,
    commitInterrupted,
    downloadResults,
    downloadFailedRows,
  } = state;

  if (!importScope || readyScope !== importScope) {
    return (
      <div className="space-y-6">
        <PageHeader title="Bulk import" description={null} />
        <Skeleton className="h-40" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Bulk import"
        description="Upload a spreadsheet of invoices — we validate every row before creating anything."
      />

      <RequireClientScope thing="bulk import">
        <AddRowsCard
          rows={rows}
          overCap={overCap}
          duplicateNumbers={duplicateNumbers}
          raw={raw}
          editRaw={editRaw}
          fileName={fileName}
          filePicker={filePicker}
          pending={importMut.isPending}
          activeRun={activeRun}
          readyScope={readyScope}
          importScope={importScope}
          startNewImport={startNewImport}
        />

        {activeRun && (
          <ImportRunStatus
            activeRun={activeRun}
            progress={progress}
            recoverySaved={recoverySaved}
          />
        )}

        <ValidateStep
          rows={rows}
          overCap={overCap}
          pending={importMut.isPending}
          result={result}
          onValidate={() => run(false)}
          onCommitClick={onCommitClick}
        />

        {commitInterrupted && (
          <CommitInterruptedAlert
            pending={importMut.isPending}
            hasRows={rows.length > 0}
            onResume={() => void run(true)}
          />
        )}

        {importMut.isPending && !result && <Skeleton className="h-40" />}

        <SkipInvalidDialog
          open={confirmCommit}
          onOpenChange={setConfirmCommit}
          knownInvalidCount={knownInvalidCount}
          onConfirm={() => {
            setConfirmCommit(false);
            run(true);
          }}
        />

        {result && (
          <ImportResultsCard
            result={result}
            onDownloadFailed={downloadFailedRows}
            onDownloadResults={downloadResults}
          />
        )}
      </RequireClientScope>
    </div>
  );
}
