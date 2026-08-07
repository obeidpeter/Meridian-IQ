import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetMe,
  useListOnboardingRuns,
  useCreateOnboardingRun,
  useRefreshOnboardingRun,
  useSkipOnboardingStep,
  useAbandonOnboardingRun,
  getListOnboardingRunsQueryKey,
} from "@workspace/api-client-react";
import type {
  OnboardingRun,
  OnboardingStep,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/query-error";
import { useToast } from "@/hooks/use-toast";
import { serverErrorToast } from "@/lib/errors";
import { pillClasses, type BadgeTone } from "@/lib/format";
import { ClipboardCheck, RefreshCw } from "lucide-react";

// Client onboarding checklist (Onboard with Clerk Phase 1): the run the firm
// opens when it takes on a new client. Every step's state is DETECTED
// server-side from the record (invoices, statement coverage, consent events,
// the filings register) — the card never marks a step done; the only human
// write it offers is a deliberate SKIP with a reason, which the server
// records as the honest gap. Buttons gate on engagement.write (the server
// enforces it regardless — the filings-card mirror), so a read-only viewer
// sees the checklist but no dead buttons.

// ---- Pure helpers (unit-tested directly) -----------------------------------

const STEP_LABELS: Record<OnboardingStep["key"], string> = {
  consent_captured: "Consent captured",
  history_imported: "Invoice history imported",
  statements_backfilled: "Bank statements backfilled",
  duplicates_reviewed: "Duplicate check clean",
  filings_synced: "Filings register backfilled",
};

export function onboardingStepLabel(key: OnboardingStep["key"]): string {
  return STEP_LABELS[key] ?? key;
}

/**
 * Pill tone per step state: done emerald, skipped slate (a recorded gap, not
 * an achievement), pending amber (work outstanding — never red: onboarding
 * is a checklist, not an overdue alarm).
 */
export function onboardingStepPill(step: Pick<OnboardingStep, "status">): {
  tone: BadgeTone;
  label: string;
} {
  if (step.status === "done") return { tone: "emerald", label: "Done" };
  if (step.status === "skipped") return { tone: "slate", label: "Skipped" };
  return { tone: "amber", label: "Pending" };
}

/** "3 of 5 settled" — done and skipped both settle a step. */
export function onboardingProgress(run: Pick<OnboardingRun, "steps">): string {
  const settled = run.steps.filter((s) => s.status !== "pending").length;
  return `${settled} of ${run.steps.length} settled`;
}

/** The run the card shows: the active one if any, else the newest. */
export function pickOnboardingRun(
  runs: OnboardingRun[],
): OnboardingRun | null {
  return runs.find((r) => r.status === "active") ?? runs[0] ?? null;
}

// ---- The card ---------------------------------------------------------------

export function OnboardingCard({ clientPartyId }: { clientPartyId: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const params = { clientPartyId };
  const { data, isLoading, error, refetch } = useListOnboardingRuns(params, {
    query: {
      enabled: !!clientPartyId,
      queryKey: getListOnboardingRunsQueryKey(params),
      staleTime: 60_000,
      retry: false,
    },
  });

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: getListOnboardingRunsQueryKey(),
    });

  const { data: me } = useGetMe();
  const canWrite = !!me?.capabilities.includes("engagement.write");

  const [skipPanelKey, setSkipPanelKey] = useState<string | null>(null);
  const [skipReason, setSkipReason] = useState("");

  const onError =
    (title: string) => (e: unknown) =>
      serverErrorToast(toast, e, { title, fallback: "Try again." });

  const create = useCreateOnboardingRun({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Onboarding started" });
      },
      onError: onError("Could not start onboarding"),
    },
  });
  const refresh = useRefreshOnboardingRun({
    mutation: {
      onSuccess: () => invalidate(),
      onError: onError("Could not refresh the checklist"),
    },
  });
  const skip = useSkipOnboardingStep({
    mutation: {
      onSuccess: () => {
        invalidate();
        setSkipPanelKey(null);
        setSkipReason("");
        toast({ title: "Gap recorded" });
      },
      onError: onError("Could not record the skip"),
    },
  });
  const abandon = useAbandonOnboardingRun({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Onboarding closed" });
      },
      onError: onError("Could not close the run"),
    },
  });

  const run = pickOnboardingRun(data?.runs ?? []);

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
            onClick={() => refresh.mutate({ id: run.id })}
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
              consent, duplicates, filings — that tracks itself from the
              record.
            </p>
            {canWrite && (
              <Button
                size="sm"
                onClick={() => create.mutate({ data: { clientPartyId } })}
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
              <span
                className={pillClasses(
                  run.status === "completed"
                    ? "emerald"
                    : run.status === "abandoned"
                      ? "slate"
                      : "blue",
                )}
                data-testid="pill-onboarding-status"
              >
                {run.status === "completed"
                  ? "Completed"
                  : run.status === "abandoned"
                    ? "Closed"
                    : "In progress"}
              </span>
              <span
                className="text-xs text-muted-foreground"
                data-testid="text-onboarding-progress"
              >
                {onboardingProgress(run)}
              </span>
            </div>
            <div className="space-y-2">
              {run.steps.map((step) => {
                const pill = onboardingStepPill(step);
                return (
                  <div
                    key={step.key}
                    className="border rounded-md p-3"
                    data-testid={`row-onboarding-${step.key}`}
                  >
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <p className="font-medium text-sm">
                        {onboardingStepLabel(step.key)}
                      </p>
                      <span
                        className={pillClasses(pill.tone)}
                        data-testid={`pill-onboarding-${step.key}`}
                      >
                        {pill.label}
                      </span>
                    </div>
                    {step.status === "skipped" && step.skippedReason && (
                      <p className="text-xs text-muted-foreground mt-1">
                        Skipped: {step.skippedReason}
                      </p>
                    )}
                    {step.status === "pending" &&
                      step.gaps.map((gap, i) => (
                        <p
                          key={i}
                          className="text-xs text-muted-foreground mt-1"
                          data-testid={`gap-onboarding-${step.key}-${i}`}
                        >
                          {gap}
                        </p>
                      ))}
                    {canWrite &&
                      run.status === "active" &&
                      step.status === "pending" && (
                        <div className="mt-2">
                          <Button
                            size="sm"
                            variant={
                              skipPanelKey === step.key
                                ? "secondary"
                                : "outline"
                            }
                            onClick={() => {
                              setSkipPanelKey((cur) =>
                                cur === step.key ? null : step.key,
                              );
                              setSkipReason("");
                            }}
                            data-testid={`button-onboarding-skip-${step.key}`}
                          >
                            Skip with reason
                          </Button>
                          {skipPanelKey === step.key && (
                            <div
                              className="mt-2 rounded-md border p-3 space-y-2"
                              data-testid={`panel-onboarding-skip-${step.key}`}
                            >
                              <div className="space-y-1">
                                <Label
                                  htmlFor={`onboarding-skip-${step.key}`}
                                >
                                  Why is this step not needed?
                                </Label>
                                <Input
                                  id={`onboarding-skip-${step.key}`}
                                  value={skipReason}
                                  onChange={(e) =>
                                    setSkipReason(e.target.value)
                                  }
                                  placeholder="e.g. client is newly incorporated — no history to import"
                                  data-testid={`input-onboarding-skip-${step.key}`}
                                />
                              </div>
                              <Button
                                size="sm"
                                onClick={() =>
                                  skip.mutate({
                                    id: run.id,
                                    stepKey: step.key,
                                    data: { reason: skipReason.trim() },
                                  })
                                }
                                disabled={
                                  skipReason.trim().length < 3 ||
                                  skip.isPending
                                }
                                data-testid={`button-onboarding-skip-confirm-${step.key}`}
                              >
                                {skip.isPending
                                  ? "Recording…"
                                  : "Record the gap"}
                              </Button>
                            </div>
                          )}
                        </div>
                      )}
                  </div>
                );
              })}
            </div>
            {canWrite && run.status === "active" && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => abandon.mutate({ id: run.id })}
                disabled={abandon.isPending}
                data-testid="button-onboarding-abandon"
              >
                Close without completing
              </Button>
            )}
            <p className="text-xs text-muted-foreground">
              Steps settle themselves from the record — the checklist only
              ever claims what the data shows; a skip records the gap it
              leaves.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
