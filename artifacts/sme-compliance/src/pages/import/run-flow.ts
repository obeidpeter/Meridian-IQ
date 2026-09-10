// The import page's run flow, cut at its stage boundaries (R126 split) so
// the resumable, idempotent commit reads as: begin the journal entry →
// resolve the intent (whose two guards fire before any run id is persisted)
// → send → report. Module-level functions, no hooks; the failure reporter
// is handed exactly one setter (setCommitInterrupted) and nothing else.
import type { QueryClient } from "@tanstack/react-query";
import {
  getListInvoicesQueryKey,
  type InvoiceImportResult,
  type InvoiceImportRow,
} from "@workspace/api-client-react";
import { beginOperation, updateOperation } from "@workspace/web-ui";
import type { useToast } from "@/hooks/use-toast";
import { errorStatus, serverErrorMessage } from "@/lib/errors";
import type { SessionWork } from "@/lib/use-session-work";
import { newImportRun, type InvoiceImportRun } from "@/lib/invoice-import-run";
import type { ImportRunApi } from "@/lib/invoice-import-run-api";

type Toast = ReturnType<typeof useToast>["toast"];
type ImportOperation = ReturnType<typeof beginOperation> | undefined;

/** The validation run's journal entry; a commit journals per chunk instead. */
export function beginImportOperation(
  commit: boolean,
  operationKey: string | null,
  rowCount: number,
): ImportOperation {
  return commit
    ? undefined
    : beginOperation(operationKey, {
        title: commit ? "Import invoices" : "Validate invoice import",
        kind: "import",
        route: "/import",
        detail: `${rowCount} row${rowCount === 1 ? "" : "s"}`,
      });
}

/**
 * The run intent for these rows: the held run when its hash still matches,
 * otherwise a new manifest — refusing to replace a started run ("already
 * started") and checking a requested run id against the server's manifest
 * ("does not match") before the caller persists anything.
 */
export async function resolveImportIntent({
  sourceIntent,
  hash,
  importScope,
  clientPartyId,
  sourceRows,
  resumeId,
  work,
  api,
}: {
  sourceIntent: InvoiceImportRun | null;
  hash: string;
  importScope: string;
  clientPartyId: string;
  sourceRows: InvoiceImportRow[];
  resumeId: string;
  work: SessionWork;
  api: ImportRunApi;
}): Promise<InvoiceImportRun> {
  let intent = sourceIntent;
  if (!intent || intent.hash !== hash) {
    if (intent?.started)
      throw new Error(
        "This import already started. Resume its original rows or choose New import.",
      );
    const localPreviewId =
      intent && !intent.started && intent.id === resumeId
        ? intent.id
        : undefined;
    intent = await newImportRun(importScope, clientPartyId, sourceRows, work);
    work.check();
    // Validation-only runs have no server manifest until their first commit.
    if (localPreviewId) {
      intent = {
        ...intent,
        id: localPreviewId,
        manifest: { ...intent.manifest, id: localPreviewId },
      };
    } else if (resumeId) {
      work.check();
      const remote = await api.get(resumeId);
      work.check();
      if (
        remote.clientPartyId !== intent.clientPartyId ||
        remote.totalRows !== intent.manifest.totalRows ||
        JSON.stringify(remote.chunkHashes) !==
          JSON.stringify(intent.manifest.chunkHashes)
      )
        throw new Error(
          "This file does not match the selected import. Upload its original file or start a New import.",
        );
      intent = {
        ...intent,
        id: resumeId,
        started: true,
        manifest: { ...intent.manifest, id: resumeId },
      };
    }
  }
  return intent;
}

// A gateway/protocol failure can arrive after a successful commit too.
export function importOutcomeUncertain(e: unknown, commit: boolean): boolean {
  return (
    commit &&
    ((errorStatus(e) ?? 0) >= 500 ||
      (errorStatus(e) ?? 0) < 400 ||
      errorStatus(e) === 408)
  );
}

/** Journal + toast for a run that returned a result. */
export function reportImportSuccess({
  res,
  commit,
  operation,
  operationKey,
  queryClient,
  toast,
}: {
  res: InvoiceImportResult;
  commit: boolean;
  operation: ImportOperation;
  operationKey: string | null;
  queryClient: QueryClient;
  toast: Toast;
}) {
  updateOperation(operationKey, operation?.id, {
    status: commit && res.invalidCount > 0 ? "partial" : "succeeded",
    detail: commit
      ? `${res.createdCount} created, ${res.invalidCount} skipped.`
      : `${res.validCount} valid, ${res.invalidCount} with issues.`,
    savedSummary: commit
      ? `${res.createdCount} invoice draft(s) were created.`
      : "Validation only; no invoices were created.",
  });
  if (commit) {
    // Not awaited: a background refetch rejection must not surface as a
    // false "import failed" error after the rows were already created.
    queryClient.invalidateQueries({ queryKey: getListInvoicesQueryKey() });
    toast({
      title: "Import complete",
      description:
        res.invalidCount > 0
          ? `${res.createdCount} draft invoice(s) created, ${res.invalidCount} row(s) skipped — see the results below.`
          : `${res.createdCount} draft invoice(s) created — review and submit them from Invoices.`,
    });
  } else {
    toast({
      title: "Validation done",
      description: `${res.validCount} valid, ${res.invalidCount} with issues.`,
    });
  }
}

/**
 * Journal + toast for a run that threw. A dropped connection (no HTTP
 * status) returns before the "rejected" wording — on a commit the server may
 * still have created the invoices.
 */
export function reportImportFailure({
  e,
  commit,
  operation,
  operationKey,
  toast,
  setCommitInterrupted,
}: {
  e: unknown;
  commit: boolean;
  operation: ImportOperation;
  operationKey: string | null;
  toast: Toast;
  setCommitInterrupted: (interrupted: boolean) => void;
}) {
  // No HTTP status means the request itself died (connection drop,
  // timeout): on a commit the server may still have created the invoices,
  // so never blame the file and never invite a blind retry.
  if (errorStatus(e) === undefined) {
    if (commit) {
      setCommitInterrupted(true);
      updateOperation(operationKey, operation?.id, {
        status: "partial",
        detail: "The connection ended before the server confirmed the import.",
        savedSummary:
          "We could not confirm the import result. Retry the same import to check what was saved without creating duplicates.",
      });
    } else {
      updateOperation(operationKey, operation?.id, {
        status: "failed",
        detail: "The server could not be reached for validation.",
        savedSummary: "Nothing was sent or created.",
      });
      toast({
        title: "Could not validate",
        description:
          "We couldn't reach the server. Check your connection and try again — nothing was sent.",
        variant: "destructive",
      });
    }
    return;
  }
  const uncertain = importOutcomeUncertain(e, commit);
  if (commit) setCommitInterrupted(true);
  updateOperation(operationKey, operation?.id, {
    status: uncertain ? "partial" : "failed",
    detail: commit ? "The server rejected the import." : "Validation failed.",
    savedSummary: uncertain
      ? "Outcome unconfirmed. Retry the same import to reconcile."
      : "The server rejected this request.",
  });
  toast({
    title: commit ? "Import failed" : "Validation failed",
    description: commit
      ? `${serverErrorMessage(e)}${uncertain ? " The outcome is unconfirmed; retry the same import." : ""}`
      : serverErrorMessage(e),
    variant: "destructive",
  });
}
