import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/query-error";
import { ClipboardCheck, RefreshCw } from "lucide-react";
import { onboardingProgress } from "./onboarding-helpers";
import { useOnboardingRun } from "./use-onboarding-run";
import {
  OnboardingRunActions,
  OnboardingStatusPill,
  OnboardingStepRow,
  OpeningPositionSection,
} from "./onboarding-card-parts";

// Client onboarding checklist (Onboard with Clerk Phase 1): the run the firm
// opens when it takes on a new client. Every step's state is DETECTED
// server-side from the record (invoices, statement coverage, consent events,
// the filings register) — the card never marks a step done; the only human
// write it offers is a deliberate SKIP with a reason, which the server
// records as the honest gap. Buttons gate on engagement.write (the server
// enforces it regardless — the filings-card mirror), so a read-only viewer
// sees the checklist but no dead buttons.
//
// R126 split the pure helpers, the run hook and the presentational parts
// into siblings; the unit suite pins the helpers through this module.

export {
  onboardingStepLabel,
  onboardingStepPill,
  onboardingProgress,
  pickOnboardingRun,
  openingSummaryLines,
} from "./onboarding-helpers";

// ---- The card ---------------------------------------------------------------

export function OnboardingCard({ clientPartyId }: { clientPartyId: string }) {
  const {
    isLoading,
    error,
    refetch,
    run,
    wantPosition,
    position,
    canWrite,
    skipPanelKey,
    setSkipPanelKey,
    skipReason,
    setSkipReason,
    confirmAbandon,
    setConfirmAbandon,
    create,
    refresh,
    skip,
    abandon,
    startOnboarding,
    refreshOnboarding,
    closeOnboarding,
    downloadReadinessReport,
  } = useOnboardingRun(clientPartyId);

  return (
    <Card data-testid="card-onboarding">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <ClipboardCheck className="w-5 h-5" aria-hidden="true" /> Onboarding
        </CardTitle>
        {canWrite && run?.status === "active" && (
          <Button
            size="sm"
            variant="outline"
            onClick={refreshOnboarding}
            disabled={refresh.isPending}
            data-testid="button-onboarding-refresh"
          >
            <RefreshCw
              className={`w-4 h-4 mr-1 ${refresh.isPending ? "animate-spin" : ""}`}
              aria-hidden="true"
            />
            {refresh.isPending ? "Checking…" : "Re-check"}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <Skeleton className="h-24 w-full" data-testid="skeleton-onboarding" />
        ) : error ? (
          <QueryError
            thing="the onboarding checklist"
            onRetry={() => refetch()}
            detail={error instanceof Error ? error.message : undefined}
          />
        ) : !run ? (
          <div className="space-y-2">
            <p
              className="text-sm text-muted-foreground"
              data-testid="text-onboarding-empty"
            >
              No onboarding run for this client. Starting one opens an
              evidence-based checklist — history import, statement backfill,
              consent, duplicates, filings — that tracks itself from the record.
            </p>
            {canWrite && (
              <Button
                size="sm"
                onClick={startOnboarding}
                disabled={create.isPending}
                data-testid="button-onboarding-start"
              >
                {create.isPending ? "Starting…" : "Start onboarding"}
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <OnboardingStatusPill run={run} />
              <span
                className="text-xs text-muted-foreground"
                data-testid="text-onboarding-progress"
              >
                {onboardingProgress(run)}
              </span>
            </div>
            <div className="space-y-2">
              {run.steps.map((step) => (
                <OnboardingStepRow
                  key={step.key}
                  run={run}
                  step={step}
                  canWrite={canWrite}
                  skipPanelKey={skipPanelKey}
                  setSkipPanelKey={setSkipPanelKey}
                  skipReason={skipReason}
                  setSkipReason={setSkipReason}
                  skip={skip}
                />
              ))}
            </div>
            {wantPosition && position && (
              <OpeningPositionSection position={position} />
            )}
            <OnboardingRunActions
              run={run}
              canWrite={canWrite}
              create={create}
              abandon={abandon}
              confirmAbandon={confirmAbandon}
              setConfirmAbandon={setConfirmAbandon}
              startOnboarding={startOnboarding}
              closeOnboarding={closeOnboarding}
              downloadReadinessReport={downloadReadinessReport}
            />
            <p className="text-xs text-muted-foreground">
              Steps settle themselves from the record — the checklist only ever
              claims what the data shows; a skip records the gap it leaves.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
