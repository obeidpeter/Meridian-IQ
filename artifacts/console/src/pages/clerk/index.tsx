// The console Clerk intake workspace (R120 split the 2,748-line file into
// this shell, the two decision forms, the bulk-approve dialog, the selects,
// the confidence badge and the constants). The route (App.tsx) keeps
// importing "@/pages/clerk": this module is the page's surface.

import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/query-error";
import { ClerkDisabledBanner, ClerkPageHeader } from "@/components/clerk-shell";
import { PowerOff } from "lucide-react";
import { greeting } from "./constants";
import { BulkApproveDialog } from "./bulk-approve-dialog";
import { useClerkWorkspace } from "./use-clerk-workspace";
import { IntakeColumn } from "./intake-column";
import { CaseDetail } from "./case-detail";

export function ClerkWorkspace() {
  const state = useClerkWorkspace();
  const {
    disabledBanner,
    clerkFlag,
    firstName,
    offset,
    isLoading,
    error,
    refetch,
    bulkCandidates,
    bulkOpen,
    setBulkOpen,
    bulkReport,
    bulkLabels,
    bulkSuggestions,
    bulkSuggestionsLoading,
    bulkApprove,
    bulkPhase,
    confirmBulkApprove,
    closeBulkDialog,
  } = state;
  if (isLoading && offset === 0) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (error) return <QueryError thing="Clerk cases" onRetry={refetch} />;

  return (
    <div className="space-y-6">
      <ClerkPageHeader
        eyebrow="Upload and review"
        title={firstName ? `${greeting()}, ${firstName}` : "Review queue"}
        description="Clerk reads documents and voice notes — it never files anything. Every case below needs your review before a record changes."
        right={
          clerkFlag ? (
            clerkFlag.enabled ? (
              <span
                className="inline-flex items-center gap-2 rounded-full border border-teal-200 bg-teal-50 px-3.5 py-1.5 text-sm font-medium text-teal-800 dark:border-teal-900 dark:bg-teal-950 dark:text-teal-300"
                data-testid="pill-guardrails"
              >
                <span
                  className="h-2 w-2 rounded-full bg-teal-500"
                  aria-hidden="true"
                />
                Approval controls on
              </span>
            ) : (
              <span
                className="inline-flex items-center gap-2 rounded-full border border-red-200 bg-red-50 px-3.5 py-1.5 text-sm font-medium text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
                data-testid="pill-guardrails"
              >
                <PowerOff className="h-3.5 w-3.5" aria-hidden="true" />
                Clerk switched off
              </span>
            )
          ) : null
        }
      />

      {disabledBanner && (
        <ClerkDisabledBanner>
          Clerk does not contact the AI provider while switched off. Ask an
          operator to check Feature flags.
        </ClerkDisabledBanner>
      )}

      <div className="grid items-start gap-5 lg:grid-cols-[22rem_minmax(0,1fr)] xl:grid-cols-[24rem_minmax(0,1fr)]">
        <IntakeColumn state={state} />
        <CaseDetail state={state} />
      </div>

      <BulkApproveDialog
        open={bulkOpen}
        onOpenChange={(o) => {
          if (!o) closeBulkDialog();
          else setBulkOpen(true);
        }}
        onClose={closeBulkDialog}
        report={bulkReport}
        phase={bulkPhase}
        candidates={bulkCandidates}
        labels={bulkLabels}
        suggestions={bulkSuggestions}
        suggestionsLoading={bulkSuggestionsLoading}
        onConfirm={confirmBulkApprove}
        approvePending={bulkApprove.isPending}
      />
    </div>
  );
}
