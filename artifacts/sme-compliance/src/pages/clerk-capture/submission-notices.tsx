import type { ClerkBatchView } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { batchSummary } from "@/lib/clerk";
import { AlertTriangle, FileCheck2 } from "lucide-react";
import type { CaptureState } from "./use-capture";

/** The queued bundle's progress card; polled by the capture hook. */
export function BatchProgressAlert({
  activeBatch,
}: {
  activeBatch: ClerkBatchView;
}) {
  return (
    <Alert
      variant={activeBatch.status === "failed" ? "destructive" : "default"}
      data-testid="batch-progress"
    >
      <FileCheck2 className="h-4 w-4" aria-hidden="true" />
      <AlertTitle>
        {activeBatch.status === "queued"
          ? "Bundle queued"
          : activeBatch.status === "processing"
            ? "Clerk is working through your bundle…"
            : activeBatch.status === "done"
              ? "Bundle processed"
              : "Bundle failed"}
      </AlertTitle>
      <AlertDescription>
        {activeBatch.status === "failed" ? (
          (activeBatch.failReason ??
          "The bundle could not be processed. Try uploading the invoices one at a time.")
        ) : activeBatch.status === "done" ? (
          <>
            {batchSummary(
              activeBatch.createdCases,
              activeBatch.skippedDuplicates,
            )}
            {activeBatch.createdCases > 0 &&
              " — your accountant will review each one before anything is created."}
          </>
        ) : (
          <>
            {activeBatch.totalSegments
              ? `${activeBatch.processedSegments} of ${activeBatch.totalSegments} invoices read`
              : "Splitting the document into invoices…"}
            {activeBatch.createdCases > 0 &&
              ` · ${activeBatch.createdCases} submitted so far`}
            {" — you can leave this page; the work continues."}
          </>
        )}
      </AlertDescription>
    </Alert>
  );
}

/**
 * The 409 DUPLICATE_SOURCE panel: "Create anyway" resubmits the held payload
 * byte-identical with allowDuplicate: true, Cancel drops it.
 */
export function DuplicateSourcePanel({
  pendingDuplicate,
  submitCase,
  setPendingDuplicate,
  createCase,
}: Pick<CaptureState, "submitCase" | "setPendingDuplicate" | "createCase"> & {
  pendingDuplicate: NonNullable<CaptureState["pendingDuplicate"]>;
}) {
  return (
    <Alert data-testid="banner-duplicate-source">
      <AlertTriangle className="h-4 w-4" aria-hidden="true" />
      <AlertTitle>Already sent this one?</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>{pendingDuplicate.message}</p>
        <div className="flex gap-2 flex-wrap">
          <Button
            size="sm"
            onClick={() =>
              submitCase({
                ...pendingDuplicate.payload,
                allowDuplicate: true,
              })
            }
            disabled={createCase.isPending}
            data-testid="button-create-anyway"
          >
            {createCase.isPending ? "Sending…" : "Create anyway"}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setPendingDuplicate(null)}
            data-testid="button-cancel-duplicate"
          >
            Cancel
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
