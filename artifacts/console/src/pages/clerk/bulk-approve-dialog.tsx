import {
  type ClerkBulkApproveReport,
  type ClerkCase,
  type ClerkPartySuggestions,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { pillClasses } from "@/lib/format";
import {
  type BulkDialogPhase,
  bulkApproveFormFromCase,
  bulkApproveSummary,
  fastLaneCaseSummary,
} from "@/pages/clerk-shared";

export function BulkApproveDialog({
  open,
  onOpenChange,
  onClose,
  report,
  phase,
  candidates,
  labels,
  suggestions,
  suggestionsLoading,
  onConfirm,
  approvePending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onClose: () => void;
  report: ClerkBulkApproveReport | null;
  phase: BulkDialogPhase;
  candidates: ClerkCase[];
  labels: Map<string, string>;
  suggestions: Map<string, ClerkPartySuggestions | undefined> | undefined;
  suggestionsLoading: boolean;
  onConfirm: () => void;
  approvePending: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {/* Once the report is in, the queue has refetched and the
                candidate list may be empty — pin the count to the batch
                that actually ran. */}
            Approve the fast lane (
            {report ? report.results.length : candidates.length})
          </DialogTitle>
          <DialogDescription>
            This only touches fast-lane cases — extraction succeeded, pre-flight
            found nothing blocking and every critical field is confident. Each
            approval creates a DRAFT invoice only; nothing is submitted. The
            server re-checks every case and skips any that no longer qualify,
            leaving them exactly as they were.
          </DialogDescription>
        </DialogHeader>
        {report ? (
          (() => {
            const summary = bulkApproveSummary(report);
            return (
              <div className="space-y-3" data-testid="bulk-approve-report">
                <p
                  className="text-sm font-medium text-emerald-700 dark:text-emerald-400"
                  role="status"
                  data-testid="text-bulk-approved-count"
                >
                  {summary.approved} case
                  {summary.approved === 1 ? "" : "s"} approved as draft
                  invoices.
                </p>
                {summary.skipped.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-sm font-medium">
                      Skipped — left exactly as they were:
                    </p>
                    <ul
                      className="space-y-1 text-xs text-muted-foreground"
                      data-testid="bulk-skipped-list"
                    >
                      {summary.skipped.map((r) => (
                        <li
                          key={r.caseId}
                          data-testid={`row-bulk-skipped-${r.caseId}`}
                        >
                          <span className="font-medium text-foreground">
                            {labels.get(r.caseId) ?? r.caseId}
                          </span>
                          : {r.reason}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <DialogFooter>
                  <Button
                    onClick={onClose}
                    data-testid="button-close-bulk-approve"
                  >
                    Close
                  </Button>
                </DialogFooter>
              </div>
            );
          })()
        ) : phase === "drained" ? (
          <>
            {/* The live queue drained the candidate list while the dialog
                was open (a refetch, or another operator decided the cases).
                Confirm stays disabled — an empty batch is a contract 400 —
                and the dialog says why instead of offering a dead button. */}
            <p
              className="text-sm text-muted-foreground"
              data-testid="text-bulk-drained"
            >
              The queue changed — nothing left to approve. The fast-lane cases
              were decided or updated while this dialog was open.
            </p>
            <DialogFooter>
              <Button
                variant="secondary"
                onClick={onClose}
                data-testid="button-cancel-bulk-approve"
              >
                Close
              </Button>
              <Button disabled data-testid="button-confirm-bulk-approve">
                Approve as drafts
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <div
              className="border rounded-md divide-y text-sm"
              data-testid="bulk-approve-rows"
            >
              {candidates.map((c) => {
                const s = fastLaneCaseSummary(c);
                const prefill = bulkApproveFormFromCase(
                  c,
                  suggestions?.get(c.id),
                );
                const unresolved =
                  !prefill.firmId ||
                  !prefill.supplierPartyId ||
                  !prefill.buyerPartyId;
                return (
                  <div
                    key={c.id}
                    className="flex items-center gap-3 px-3 py-2"
                    data-testid={`row-bulk-case-${c.id}`}
                  >
                    <span className="flex-1 min-w-0 truncate font-medium">
                      {s.supplier}
                    </span>
                    <span className="text-muted-foreground">
                      {s.invoiceNumber}
                    </span>
                    <span className="tabular-nums">{s.amount}</span>
                    {!suggestionsLoading && unresolved && (
                      <span
                        className={pillClasses("amber")}
                        title="No firm or register match resolved — the server will skip this case; approve it from the single-case review instead."
                        data-testid={`pill-bulk-unresolved-${c.id}`}
                      >
                        will be skipped
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            <DialogFooter>
              <Button
                variant="secondary"
                onClick={onClose}
                data-testid="button-cancel-bulk-approve"
              >
                Cancel
              </Button>
              <Button
                onClick={onConfirm}
                disabled={approvePending || suggestionsLoading}
                data-testid="button-confirm-bulk-approve"
              >
                {approvePending
                  ? "Approving…"
                  : `Approve ${candidates.length} as drafts`}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
