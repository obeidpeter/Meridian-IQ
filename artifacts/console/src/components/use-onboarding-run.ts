import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetMe,
  useListOnboardingRuns,
  useCreateOnboardingRun,
  useRefreshOnboardingRun,
  useSkipOnboardingStep,
  useAbandonOnboardingRun,
  useGetOnboardingOpeningPosition,
  getListOnboardingRunsQueryKey,
  getGetOnboardingOpeningPositionQueryKey,
  getGetOnboardingReportUrl,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { serverErrorToast } from "@/lib/errors";
import { triggerDownload } from "@/lib/download";
import {
  beginOperation,
  operationSessionKey,
  updateOperation,
} from "@workspace/web-ui";
import { pickOnboardingRun } from "./onboarding-helpers";

// Everything the onboarding card holds and does (R126 moved it out of the
// card): the runs query, the opening position, the write capability, the
// skip panel state and the four mutations with their operation records.
export function useOnboardingRun(clientPartyId: string) {
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

  const run = pickOnboardingRun(data?.runs ?? []);

  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: getListOnboardingRunsQueryKey(),
    });
    if (run) {
      void queryClient.invalidateQueries({
        queryKey: getGetOnboardingOpeningPositionQueryKey(run.id),
      });
    }
  };

  // The day-one position: frozen once the run completes, a live provisional
  // picture while it is active. NOT fetched for an abandoned run — its
  // picture would stay "provisional" forever at full recompute cost, a
  // baseline pending nothing.
  const wantPosition = !!run && run.status !== "abandoned";
  const { data: position } = useGetOnboardingOpeningPosition(run?.id ?? "", {
    query: {
      enabled: wantPosition,
      queryKey: getGetOnboardingOpeningPositionQueryKey(run?.id ?? ""),
      staleTime: 60_000,
      retry: false,
    },
  });

  const { data: me } = useGetMe();
  const canWrite = !!me?.capabilities.includes("engagement.write");
  const operationKey = operationSessionKey(me);

  const [skipPanelKey, setSkipPanelKey] = useState<string | null>(null);
  const [skipReason, setSkipReason] = useState("");
  const [confirmAbandon, setConfirmAbandon] = useState(false);

  const onError = (title: string) => (e: unknown) =>
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

  const startOnboarding = () => {
    const operation = beginOperation(operationKey, {
      title: "Start client onboarding",
      kind: "onboarding",
      route: `/clients/${clientPartyId}?view=setup`,
    });
    create.mutate(
      { data: { clientPartyId } },
      {
        onSuccess: () =>
          updateOperation(operationKey, operation?.id, {
            status: "succeeded",
            detail: "The onboarding run and evidence checklist were created.",
            savedSummary: "A new onboarding run is active.",
          }),
        onError: () =>
          updateOperation(operationKey, operation?.id, {
            status: "failed",
            detail: "The onboarding run could not be created.",
            savedSummary: "No onboarding run was started.",
          }),
      },
    );
  };

  const refreshOnboarding = () => {
    if (!run) return;
    const operation = beginOperation(operationKey, {
      title: `Re-check onboarding for ${run.clientName}`,
      kind: "onboarding",
      route: `/clients/${clientPartyId}?view=setup`,
    });
    refresh.mutate(
      { id: run.id },
      {
        onSuccess: () =>
          updateOperation(operationKey, operation?.id, {
            status: "succeeded",
            detail: "Every checklist step was checked against current records.",
            savedSummary: "The onboarding checklist was refreshed.",
          }),
        onError: () =>
          updateOperation(operationKey, operation?.id, {
            status: "failed",
            detail: "The checklist could not be refreshed.",
            savedSummary: "The previous checklist state remains available.",
          }),
      },
    );
  };

  const closeOnboarding = () => {
    if (!run) return;
    const operation = beginOperation(operationKey, {
      title: `Close onboarding for ${run.clientName}`,
      kind: "onboarding",
      route: `/clients/${clientPartyId}?view=setup`,
    });
    abandon.mutate(
      { id: run.id },
      {
        onSuccess: () =>
          updateOperation(operationKey, operation?.id, {
            status: "succeeded",
            detail: "The run was closed with its current evidence preserved.",
            savedSummary: "The onboarding checklist is frozen and auditable.",
          }),
        onError: () =>
          updateOperation(operationKey, operation?.id, {
            status: "failed",
            detail: "The onboarding run could not be closed.",
            savedSummary: "The run remains active.",
          }),
      },
    );
  };

  const downloadReadinessReport = () => {
    if (!run) return;
    const filename = `onboarding-readiness-${run.clientPartyId.slice(0, 8)}.pdf`;
    const operation = beginOperation(operationKey, {
      title: `Download onboarding report for ${run.clientName}`,
      kind: "export",
      route: `/clients/${clientPartyId}?view=setup`,
    });
    triggerDownload(getGetOnboardingReportUrl(run.id), filename);
    updateOperation(operationKey, operation?.id, {
      status: "succeeded",
      detail: "The readiness-report download was started.",
      savedSummary: `The browser was asked to save ${filename}.`,
    });
  };

  return {
    data,
    isLoading,
    error,
    refetch,
    run,
    invalidate,
    wantPosition,
    position,
    me,
    canWrite,
    operationKey,
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
  };
}
