import { useQueryClient } from "@tanstack/react-query";
import {
  getGetActionDecisionsQueryKey,
  getGetActionPoliciesQueryKey,
  getGetActionProposalsQueryKey,
  getGetDashboardSummaryQueryKey,
  getGetMonthEndCloseQueryKey,
  getGetPenaltyExposureQueryKey,
  getListInvoicesQueryKey,
  useExecuteAction,
  useGrantActionPolicy,
  usePauseActionPolicy,
  useResumeActionPolicy,
  useRevokeActionPolicy,
} from "@workspace/api-client-react";
import type {
  ActionProposal,
  ClerkActionPolicy,
  AutomationEvidence,
} from "@workspace/api-client-react";
import { useCallback, useState } from "react";

import { apiErrorMessage } from "@/lib/api-error";
import {
  actionConfirmButtonLabel,
  actionConfirmDescription,
  actionOutcomeSummary,
  automatableActionKind,
  POLICY_CAP_DEFAULT,
  POLICY_PAUSE_CONFIRM,
  POLICY_RESUME_CONFIRM,
  POLICY_REVOKE_CONFIRM,
  policyGrantAlertMessage,
  policyKindLabel,
} from "@/lib/automation";
import { confirmThen } from "@/lib/confirm";

/**
 * The Automation screen's writes: approve-and-run a batch, grant a standing
 * approval (the consent moment), and pause/resume/revoke a grant — each
 * behind its confirm, with the outcome banner and the one `busy` flag both
 * the proposal cards and the policy rows disable on.
 */
export function useAutomationActions({
  clientPartyId,
  evidence,
}: {
  clientPartyId: string | null;
  evidence: AutomationEvidence | undefined;
}) {
  const queryClient = useQueryClient();

  const [banner, setBanner] = useState<{
    tone: "success" | "error";
    message: string;
  } | null>(null);

  const execute = useExecuteAction();
  const grant = useGrantActionPolicy();
  const pause = usePauseActionPolicy();
  const resume = useResumeActionPolicy();
  const revoke = useRevokeActionPolicy();
  const policyBusy =
    grant.isPending || pause.isPending || resume.isPending || revoke.isPending;
  const busy = execute.isPending || policyBusy;

  // Prefix keys (no args): every param variant goes stale together.
  const invalidatePolicyQueries = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: getGetActionPoliciesQueryKey(),
    });
  }, [queryClient]);

  const invalidateAfterRun = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: getGetActionProposalsQueryKey(),
    });
    void queryClient.invalidateQueries({
      queryKey: getGetActionDecisionsQueryKey(),
    });
    // A batch just submitted invoices — the surfaces computed from them go
    // stale together (the web card's exact set).
    void queryClient.invalidateQueries({ queryKey: getListInvoicesQueryKey() });
    void queryClient.invalidateQueries({
      queryKey: getGetDashboardSummaryQueryKey(),
    });
    void queryClient.invalidateQueries({
      queryKey: getGetPenaltyExposureQueryKey(),
    });
    void queryClient.invalidateQueries({
      queryKey: getGetMonthEndCloseQueryKey(),
    });
  }, [queryClient]);

  const runApprove = useCallback(
    async (action: ActionProposal, kind: "submit_overdue" | "retry_failed") => {
      setBanner(null);
      try {
        const result = await execute.mutateAsync({
          data: {
            kind,
            invoiceIds: action.targets.map((t) => t.invoiceId),
            clientPartyId: clientPartyId ?? undefined,
          },
        });
        invalidateAfterRun();
        setBanner({
          tone: "success",
          message: `Batch complete — ${actionOutcomeSummary(result.decision)}`,
        });
      } catch (error) {
        setBanner({
          tone: "error",
          message: apiErrorMessage(
            error,
            "We couldn't run that batch. Please try again.",
          ),
        });
      }
    },
    [execute, clientPartyId, invalidateAfterRun],
  );

  const confirmApprove = useCallback(
    (action: ActionProposal) => {
      const kind = automatableActionKind(action.kind);
      if (!kind) return;
      confirmThen(
        `Approve: ${action.title}`,
        actionConfirmDescription(kind, action.targets.length),
        actionConfirmButtonLabel(kind, action.targets.length),
        () => void runApprove(action, kind),
      );
    },
    [runApprove],
  );

  const runGrant = useCallback(
    async (kind: "submit_overdue" | "retry_failed") => {
      setBanner(null);
      try {
        await grant.mutateAsync({
          data: {
            kind,
            clientPartyId: clientPartyId ?? undefined,
            maxTargetsPerRun: POLICY_CAP_DEFAULT,
          },
        });
        invalidatePolicyQueries();
        setBanner({
          tone: "success",
          message: `Daily automation is on — ${policyKindLabel(
            kind,
          )}, up to ${POLICY_CAP_DEFAULT} per run. You can pause or revoke it below.`,
        });
      } catch (error) {
        setBanner({
          tone: "error",
          message: apiErrorMessage(
            error,
            "We couldn't turn on that automation. Please try again.",
          ),
        });
      }
    },
    [grant, clientPartyId, invalidatePolicyQueries],
  );

  // The grant confirm IS the consent moment: the copy states the fixed cap
  // of 10 being agreed to (mobile v1 has no numeric input by design — a
  // different ceiling is chosen on the web), with the client's own backtest
  // appended as a second paragraph when there is one to show.
  const confirmAutomate = useCallback(
    (action: ActionProposal) => {
      const kind = automatableActionKind(action.kind);
      if (!kind) return;
      confirmThen(
        policyKindLabel(kind),
        policyGrantAlertMessage(kind, POLICY_CAP_DEFAULT, evidence?.kinds),
        "Turn on daily automation",
        () => void runGrant(kind),
      );
    },
    [runGrant, evidence],
  );

  const runPolicyChange = useCallback(
    async (
      mutate: () => Promise<unknown>,
      successMessage: string,
      failureFallback: string,
    ) => {
      setBanner(null);
      try {
        await mutate();
        invalidatePolicyQueries();
        setBanner({ tone: "success", message: successMessage });
      } catch (error) {
        setBanner({
          tone: "error",
          message: apiErrorMessage(error, failureFallback),
        });
      }
    },
    [invalidatePolicyQueries],
  );

  const confirmPause = useCallback(
    (policy: ClerkActionPolicy) =>
      confirmThen(
        POLICY_PAUSE_CONFIRM.title,
        POLICY_PAUSE_CONFIRM.message,
        POLICY_PAUSE_CONFIRM.confirmLabel,
        () =>
          void runPolicyChange(
            () => pause.mutateAsync({ id: policy.id }),
            `${policyKindLabel(policy.kind)} is paused.`,
            "We couldn't pause that automation. Please try again.",
          ),
      ),
    [pause, runPolicyChange],
  );

  const confirmResume = useCallback(
    (policy: ClerkActionPolicy) =>
      confirmThen(
        POLICY_RESUME_CONFIRM.title,
        POLICY_RESUME_CONFIRM.message,
        POLICY_RESUME_CONFIRM.confirmLabel,
        () =>
          void runPolicyChange(
            () => resume.mutateAsync({ id: policy.id }),
            `${policyKindLabel(policy.kind)} will run again from its next sweep.`,
            "We couldn't resume that automation. Please try again.",
          ),
      ),
    [resume, runPolicyChange],
  );

  const confirmRevoke = useCallback(
    (policy: ClerkActionPolicy) =>
      confirmThen(
        POLICY_REVOKE_CONFIRM.title,
        POLICY_REVOKE_CONFIRM.message,
        POLICY_REVOKE_CONFIRM.confirmLabel,
        () =>
          void runPolicyChange(
            () => revoke.mutateAsync({ id: policy.id }),
            `${policyKindLabel(policy.kind)} is revoked.`,
            "We couldn't revoke that automation. Please try again.",
          ),
        true,
      ),
    [revoke, runPolicyChange],
  );

  return {
    banner,
    busy,
    confirmApprove,
    confirmAutomate,
    confirmPause,
    confirmResume,
    confirmRevoke,
  };
}
