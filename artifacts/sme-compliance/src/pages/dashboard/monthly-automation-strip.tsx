import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetPlanPolicies,
  getGetPlanPoliciesQueryKey,
  useGrantPlanPolicy,
  usePausePlanPolicy,
  useResumePlanPolicy,
  useRevokePlanPolicy,
  useGetClientAutomationEvidence,
  getGetClientAutomationEvidenceQueryKey,
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
import { useToast } from "@/hooks/use-toast";
import { serverErrorMessage } from "@/lib/errors";
import { planEvidenceLine } from "@/lib/format";
import { planPolicyStatusLine } from "./helpers";

export function MonthlyAutomationStrip({
  clientPartyId,
}: {
  clientPartyId: string;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const { data } = useGetPlanPolicies(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getGetPlanPoliciesQueryKey({ clientPartyId }),
        staleTime: 60_000,
        retry: false,
      },
    },
  );
  // Automation evidence (Prove with Clerk phase 2): the client's OWN
  // backtest, so the monthly consent leads with "your own record".
  // Render-on-success and advisory only — no evidence means no line, and
  // the line never gates the grant button.
  const { data: automationEvidence } = useGetClientAutomationEvidence(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getGetClientAutomationEvidenceQueryKey({ clientPartyId }),
        staleTime: 5 * 60_000,
        retry: false,
      },
    },
  );
  const planEvidence = automationEvidence
    ? planEvidenceLine(automationEvidence.kinds)
    : null;
  const onChanged = () =>
    queryClient.invalidateQueries({ queryKey: getGetPlanPoliciesQueryKey() });
  const onError = (e: unknown) =>
    toast({
      title: "Automation change failed",
      description: serverErrorMessage(e),
      variant: "destructive",
    });
  const grant = useGrantPlanPolicy({
    mutation: {
      onSuccess: () => {
        setConfirming(false);
        onChanged();
      },
      onError,
    },
  });
  const pause = usePausePlanPolicy({
    mutation: { onSuccess: onChanged, onError },
  });
  const resume = useResumePlanPolicy({
    mutation: { onSuccess: onChanged, onError },
  });
  const revoke = useRevokePlanPolicy({
    mutation: { onSuccess: onChanged, onError },
  });
  if (!data) return null;
  const policy = data.policies.find((p) => p.templateKey === "month_end_close");
  // No grant and no way to make one: the strip has nothing to say.
  if (!policy && !data.enabled) return null;
  const busy =
    grant.isPending || pause.isPending || resume.isPending || revoke.isPending;
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-3 text-xs"
      data-testid="monthly-automation"
    >
      {policy ? (
        <>
          <span className="font-medium text-foreground">
            Monthly automation
          </span>
          <span
            className={
              policy.pausedAt
                ? "text-amber-700 dark:text-amber-400"
                : "text-muted-foreground"
            }
            data-testid="text-plan-policy-status"
          >
            {planPolicyStatusLine(policy)}
          </span>
          <span className="ml-auto flex gap-1">
            {policy.pausedAt ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => resume.mutate({ id: policy.id })}
                disabled={busy}
                data-testid="button-plan-policy-resume"
              >
                Resume
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => pause.mutate({ id: policy.id })}
                disabled={busy}
                data-testid="button-plan-policy-pause"
              >
                Pause
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => revoke.mutate({ id: policy.id })}
              disabled={busy}
              data-testid="button-plan-policy-revoke"
            >
              Revoke
            </Button>
          </span>
        </>
      ) : (
        <>
          <span className="text-muted-foreground">
            Let Clerk run this close every month, with your standing approval.
          </span>
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            onClick={() => setConfirming(true)}
            disabled={busy}
            data-testid="button-plan-policy-grant"
          >
            Run monthly
          </Button>
        </>
      )}
      {/* Consent-grade confirm: granting runs no batch — it stands until
          revoked, so the copy says exactly what will happen each month. */}
      <Dialog
        open={confirming}
        onOpenChange={(open) => !open && setConfirming(false)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Run month-end close monthly</DialogTitle>
            {/* The client's own backtest, before the consent sentence —
                absent entirely when there is no evidence to show. */}
            {planEvidence && (
              <p
                className="text-sm text-muted-foreground"
                data-testid="text-plan-evidence"
              >
                {planEvidence}
              </p>
            )}
            <DialogDescription>
              Each month, Clerk will run this close plan for your business:
              raise draft invoices for regular customers you have not billed
              this cycle (drafts stay for your review — nothing is sent), submit
              invoices past the reporting window, then retry failed submissions.
              Every step re-checks eligibility at run time and every action is
              recorded. If a run halts, or anything about the engagement,
              consent or the approver changes, the automation pauses itself and
              waits for you. You can pause or revoke it at any time.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirming(false)}
              disabled={grant.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={() =>
                grant.mutate({
                  data: { templateKey: "month_end_close", clientPartyId },
                })
              }
              disabled={grant.isPending}
              data-testid="button-confirm-plan-policy"
            >
              {grant.isPending ? "Working…" : "Turn on monthly run"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
