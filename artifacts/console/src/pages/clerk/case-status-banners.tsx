import type { ClerkCase } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { noticeTypeLabel } from "@/pages/clerk-shared";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import type { ClerkWorkspaceState } from "./use-clerk-workspace";

// The selected case's status banners (R126 moved them out of the review
// pane): the notice type, the failed / escalated alerts with the retry
// path, and the pre-flight verdict.
export function CaseStatusBanners({
  selected,
  retryCase,
}: {
  selected: ClerkCase;
  retryCase: ClerkWorkspaceState["retryCase"];
}) {
  return (
    <>
      {/* What kind of notice this is, front and centre — the
                        first thing an operator triages a notice by. The
                        extracted value is free text; the label maps
                        humanize the catalogue values and anything else
                        falls back to plain humanization. */}
      {selected.kind === "notice" && selected.noticeExtraction && (
        <div
          className="rounded-lg border border-violet-200 bg-violet-50/60 p-4 dark:border-violet-900 dark:bg-violet-950/30"
          data-testid="card-notice-type"
        >
          <p className="text-xs font-semibold text-muted-foreground">
            Tax authority notice
          </p>
          <p
            className="mt-1 text-lg font-semibold"
            data-testid="text-notice-type"
          >
            {noticeTypeLabel(selected.noticeExtraction.noticeType)}
          </p>
        </div>
      )}

      {selected.status === "failed" && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          <AlertTitle>Reading failed</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>
              {selected.failReason ??
                "Clerk could not read this document. Try again or enter the details manually."}
            </p>
            {/* Retry re-runs extraction on the stored source —
                              only failed extraction cases qualify (the server
                              409s anything else). */}
            {selected.kind === "extraction" && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => retryCase.mutate({ id: selected.id })}
                disabled={retryCase.isPending}
                data-testid="button-retry-case"
              >
                {retryCase.isPending ? "Trying again…" : "Try again"}
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}
      {selected.status === "escalated" && (
        <Alert>
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          <AlertTitle>Escalated</AlertTitle>
          <AlertDescription>
            {selected.decisionReason ??
              "This case needs a human decision outside the Clerk."}
          </AlertDescription>
        </Alert>
      )}

      {/* Deterministic pre-approval checks, computed by the
                        server on every successful extraction. null means the
                        extraction never succeeded (or predates pre-flight) —
                        render nothing rather than a false all-clear. */}
      {(selected.status === "extracted" || selected.status === "in_review") &&
        selected.preflight != null &&
        (selected.preflight.length === 0 ? (
          <p
            className="flex items-center gap-1.5 text-sm font-medium text-emerald-700 dark:text-emerald-400"
            data-testid="preflight-clear"
          >
            <ShieldCheck className="h-4 w-4" aria-hidden="true" />
            Approval checks passed. Review the details before approving.
          </p>
        ) : (
          <div
            className="rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/40"
            data-testid="preflight-issues"
          >
            <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
              Approval checks:{" "}
              {selected.preflight.length === 1
                ? "1 issue"
                : `${selected.preflight.length} issues`}{" "}
              to resolve before approval
            </p>
            <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm text-amber-800 dark:text-amber-300">
              {selected.preflight.map((issue, i) => (
                <li key={`${issue.field}-${i}`}>{issue.message}</li>
              ))}
            </ul>
          </div>
        ))}
    </>
  );
}
