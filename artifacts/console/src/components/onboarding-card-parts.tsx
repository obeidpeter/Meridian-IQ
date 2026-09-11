import type { Dispatch, SetStateAction } from "react";
import type {
  OnboardingRun,
  OnboardingStep,
  OpeningPosition,
  useAbandonOnboardingRun,
  useCreateOnboardingRun,
  useSkipOnboardingStep,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { pillClasses } from "@/lib/format";
import { Download } from "lucide-react";
import {
  onboardingStepLabel,
  onboardingStepPill,
  openingSummaryLines,
} from "./onboarding-helpers";

// The onboarding card's presentational parts (R126): the run's status pill,
// one checklist row with its skip panel, the day-one position and the
// run-level actions. Top-level declarations so the controlled skip-reason
// input keeps its element identity across keystrokes.

export function OnboardingStatusPill({ run }: { run: OnboardingRun }) {
  return (
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
  );
}

export function OnboardingStepRow({
  run,
  step,
  canWrite,
  skipPanelKey,
  setSkipPanelKey,
  skipReason,
  setSkipReason,
  skip,
}: {
  run: OnboardingRun;
  step: OnboardingStep;
  canWrite: boolean;
  skipPanelKey: string | null;
  setSkipPanelKey: Dispatch<SetStateAction<string | null>>;
  skipReason: string;
  setSkipReason: Dispatch<SetStateAction<string>>;
  skip: ReturnType<typeof useSkipOnboardingStep>;
}) {
  const pill = onboardingStepPill(step);
  return (
    <div
      className="border rounded-md p-3"
      data-testid={`row-onboarding-${step.key}`}
    >
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="font-medium text-sm">{onboardingStepLabel(step.key)}</p>
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
      {canWrite && run.status === "active" && step.status === "pending" && (
        <div className="mt-2">
          <Button
            size="sm"
            variant={skipPanelKey === step.key ? "secondary" : "outline"}
            onClick={() => {
              setSkipPanelKey((cur) => (cur === step.key ? null : step.key));
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
                <Label htmlFor={`onboarding-skip-${step.key}`}>
                  Why are you skipping this step?
                </Label>
                <Input
                  id={`onboarding-skip-${step.key}`}
                  value={skipReason}
                  onChange={(e) => setSkipReason(e.target.value)}
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
                disabled={skipReason.trim().length < 3 || skip.isPending}
                data-testid={`button-onboarding-skip-confirm-${step.key}`}
              >
                {skip.isPending ? "Recording…" : "Skip and record reason"}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function OpeningPositionSection({
  position,
}: {
  position: OpeningPosition;
}) {
  return (
    <div
      className="border rounded-md p-3 space-y-1"
      data-testid="section-onboarding-position"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="font-medium text-sm">Starting financial position</p>
        {position.provisional && (
          <span
            className={pillClasses("slate")}
            data-testid="pill-onboarding-position-provisional"
          >
            Provisional
          </span>
        )}
      </div>
      {openingSummaryLines(position).map((line) => (
        <p
          key={line.label}
          className="text-xs text-muted-foreground"
          data-testid={`line-onboarding-position-${line.label
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")}`}
        >
          {line.label}: <span className="text-foreground">{line.value}</span>
        </p>
      ))}
    </div>
  );
}

export function OnboardingRunActions({
  run,
  canWrite,
  create,
  abandon,
  confirmAbandon,
  setConfirmAbandon,
  startOnboarding,
  closeOnboarding,
  downloadReadinessReport,
}: {
  run: OnboardingRun;
  canWrite: boolean;
  create: ReturnType<typeof useCreateOnboardingRun>;
  abandon: ReturnType<typeof useAbandonOnboardingRun>;
  confirmAbandon: boolean;
  setConfirmAbandon: Dispatch<SetStateAction<boolean>>;
  startOnboarding: () => void;
  closeOnboarding: () => void;
  downloadReadinessReport: () => void;
}) {
  return (
    <>
      {run.status === "completed" && (
        <Button
          size="sm"
          variant="outline"
          onClick={downloadReadinessReport}
          data-testid="button-onboarding-report"
        >
          <Download className="w-4 h-4 mr-1" aria-hidden="true" />
          Download readiness report (PDF)
        </Button>
      )}
      {canWrite && run.status === "active" && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setConfirmAbandon(true)}
          disabled={abandon.isPending}
          data-testid="button-onboarding-abandon"
        >
          Close without completing
        </Button>
      )}
      {canWrite && run.status === "abandoned" && (
        <div className="space-y-2">
          <p
            className="text-sm text-muted-foreground"
            data-testid="text-onboarding-closed"
          >
            This onboarding checklist was closed before completion and no longer
            updates. Start a new checklist to continue onboarding.
          </p>
          <Button
            size="sm"
            onClick={startOnboarding}
            disabled={create.isPending}
            data-testid="button-onboarding-restart"
          >
            {create.isPending ? "Starting…" : "Start onboarding"}
          </Button>
        </div>
      )}
      <AlertDialog open={confirmAbandon} onOpenChange={setConfirmAbandon}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Close onboarding without completing it?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This checklist will close and stop checking for progress. Its
              current results will be kept. You can start a new checklist for
              {run.clientName} afterwards.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={abandon.isPending}
              onClick={closeOnboarding}
              data-testid="button-onboarding-abandon-confirm"
            >
              Close without completing
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
