import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Link } from "wouter";
import { FileSpreadsheet } from "lucide-react";
import type { InvoiceImportRun } from "@/lib/invoice-import-run";
import { StepMark } from "./step-mark";
import type { ImportRunState } from "./use-import-run";

/** The active run's one-line status (id, batch progress, recovery note). */
export function ImportRunStatus({
  activeRun,
  progress,
  recoverySaved,
}: Pick<ImportRunState, "progress" | "recoverySaved"> & {
  activeRun: InvoiceImportRun;
}) {
  return (
    <p role="status" className="text-sm text-muted-foreground">
      Import {activeRun.id}.{" "}
      {progress
        ? `${progress.completed} of ${progress.total} batches confirmed.`
        : activeRun.started
          ? "Ready to resume."
          : "Ready to validate."}
      {!recoverySaved && " Device recovery is unavailable. Keep this tab open."}
    </p>
  );
}

/** Step 2 — Validate rows / Import valid rows and the validate-first hint. */
export function ValidateStep({
  rows,
  overCap,
  pending,
  result,
  onValidate,
  onCommitClick,
}: Pick<ImportRunState, "rows" | "overCap" | "result" | "onCommitClick"> & {
  pending: boolean;
  onValidate: () => void;
}) {
  return (
    <div className="space-y-3">
      <h2 className="flex items-center gap-2.5 text-base font-bold leading-snug">
        <StepMark n={2} done={!!result} />
        Validate and import
      </h2>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="outline"
          onClick={onValidate}
          disabled={rows.length === 0 || overCap || pending}
          data-testid="button-validate"
        >
          Validate rows
        </Button>
        <Button
          onClick={onCommitClick}
          disabled={
            rows.length === 0 ||
            overCap ||
            pending ||
            !result ||
            result.committed
          }
          data-testid="button-commit"
        >
          <FileSpreadsheet className="w-4 h-4 mr-2" aria-hidden="true" />
          {pending ? "Working…" : "Import valid rows"}
        </Button>
        {!result && rows.length > 0 && !overCap && (
          <p className="text-sm text-muted-foreground">
            Validate first — commit unlocks after a validation pass.
          </p>
        )}
      </div>
    </div>
  );
}

/** The "we couldn't confirm the import" alert with its resume button. */
export function CommitInterruptedAlert({
  pending,
  hasRows,
  onResume,
}: {
  pending: boolean;
  hasRows: boolean;
  onResume: () => void;
}) {
  return (
    <Alert variant="destructive" data-testid="alert-commit-interrupted">
      <AlertTitle>We couldn't confirm the import</AlertTitle>
      <AlertDescription>
        We could not confirm which invoices were saved. Retrying these unchanged
        rows checks the same import without creating duplicates.{" "}
        <Link href="/invoices" className="font-medium underline">
          Check your Invoices list
        </Link>{" "}
        or retry this import now.
        {hasRows ? (
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={onResume}
            className="mt-2"
          >
            Resume this import
          </Button>
        ) : (
          <p className="mt-2">
            Upload the original file to resume this import.
          </p>
        )}
      </AlertDescription>
    </Alert>
  );
}

/** The skip-invalid-rows confirmation before a commit with known invalid rows. */
export function SkipInvalidDialog({
  open,
  onOpenChange,
  knownInvalidCount,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  knownInvalidCount: number;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Skip {knownInvalidCount} invalid row(s)?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Only valid rows become invoices — the {knownInvalidCount} row(s)
            with issues are skipped. Afterwards, use “Download failed rows” in
            the results to fix and re-import just those rows.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Go back and fix</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            data-testid="button-confirm-import"
          >
            Import valid rows
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
