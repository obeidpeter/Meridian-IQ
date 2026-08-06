import { useQueryClient } from "@tanstack/react-query";
import {
  useGetActionProposals,
  getGetActionProposalsQueryKey,
  useExecuteAction,
  useGetActionDecisions,
  getGetActionDecisionsQueryKey,
  useGetActionPolicies,
  getGetActionPoliciesQueryKey,
  useGetClientAutomationEvidence,
  getGetClientAutomationEvidenceQueryKey,
  useGrantActionPolicy,
  usePauseActionPolicy,
  useResumeActionPolicy,
  useRevokeActionPolicy,
  getListInvoicesQueryKey,
  getGetDashboardSummaryQueryKey,
  getGetReceivablesSummaryQueryKey,
  getGetPenaltyExposureQueryKey,
  getGetMonthEndCloseQueryKey,
} from "@workspace/api-client-react";
import type {
  ActionProposal,
  ClerkActionDecision,
  ClerkActionPolicy,
  PaymentChaserDraft,
} from "@workspace/api-client-react";
import { useActionPolicyControls, useClerkActionsDialog } from "@workspace/web-ui";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import {
  ACTION_OUTCOME_LABELS,
  ACTION_TARGET_DISPLAY_CAP,
  POLICY_CAP_DEFAULT,
  POLICY_CAP_MAX,
  POLICY_CAP_MIN,
  actionConfirmButtonLabel,
  actionConfirmDescription,
  actionOutcomeSummary,
  actionOutcomeToneClasses,
  actionTargetOverflowNote,
  actionTruncatedNote,
  automatableActionKind,
  type AutomatableActionKind,
  decisionLine,
  draftClipboardText,
  formatAmount,
  formatDate,
  parsePolicyCap,
  policyEvidenceLine,
  policyGrantDescription,
  policyKindLabel,
  policyStatusLine,
  summaryPillClasses,
} from "@/lib/format";
import { Send, Sparkles } from "lucide-react";

// Proposed actions (round 21): Clerk assembles the batch from the same
// checks that power the dashboard cards; NOTHING runs until the owner
// approves. Approval executes through the ordinary submission path —
// validation, consent, any approval policy — and every target is re-checked
// at that moment. Renders when a proposal exists OR the results dialog is
// open (the F1 rule) OR a live standing approval exists OR decision history
// exists — a dark clerk_actions flag still answers an empty proposals list
// (fail-closed), which empties the suggestions without by itself hiding the
// card. The dialog machine (F1 unmount guard, mid-flight close gate,
// deferred invalidations, transient drafts) is the shared headless core
// (@workspace/web-ui useClerkActionsDialog); the copy is lib/format's.
export function ClerkActionsCard({ clientPartyId }: { clientPartyId: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const execute = useExecuteAction();
  const { data: proposals, isSuccess } = useGetActionProposals(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getGetActionProposalsQueryKey({ clientPartyId }),
        staleTime: 60_000,
        retry: false,
      },
    },
  );
  // The run record (round 29): who approved what — including the sweep's
  // policy runs — with per-target outcomes. The console card has carried
  // this strip since round 22; the SME owner who GRANTS an automation gets
  // the same evidence where they granted it.
  const { data: decisions } = useGetActionDecisions(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getGetActionDecisionsQueryKey({ clientPartyId }),
        staleTime: 60_000,
        retry: false,
      },
    },
  );
  // Standing approvals (round 28): the owner's live grants plus the
  // clerk_action_policies flag — `enabled` gates the "automate" affordance,
  // while existing grants stay visible (and revocable) regardless.
  const { data: policies } = useGetActionPolicies(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getGetActionPoliciesQueryKey({ clientPartyId }),
        staleTime: 60_000,
        retry: false,
      },
    },
  );
  // Automation evidence (Prove with Clerk phase 2): the client's OWN
  // backtest, fetched at the card level so the grant dialog opens with it.
  // Render-on-success and advisory only — no evidence (empty sample, failed
  // fetch, older server) means no line, and the line never gates granting.
  const { data: evidence } = useGetClientAutomationEvidence(
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
  const onPolicyChanged = () =>
    queryClient.invalidateQueries({
      queryKey: getGetActionPoliciesQueryKey(),
    });
  const policyError = (e: unknown) =>
    toast({
      title: "Automation change failed",
      description: serverErrorMessage(e),
      variant: "destructive",
    });
  const grant = useGrantActionPolicy({
    mutation: { onSuccess: onPolicyChanged, onError: policyError },
  });
  const pause = usePauseActionPolicy({
    mutation: { onSuccess: onPolicyChanged, onError: policyError },
  });
  const resume = useResumeActionPolicy({
    mutation: { onSuccess: onPolicyChanged, onError: policyError },
  });
  const revoke = useRevokeActionPolicy({
    mutation: { onSuccess: onPolicyChanged, onError: policyError },
  });
  // The grant-dialog state, the cap-validity gate and the policy
  // derivations (policyBusy, policyByKind, the amber-worthy pausedCount)
  // are the shared headless core (@workspace/web-ui
  // useActionPolicyControls, the dialog machine's sibling); the four
  // mutations above stay here — they bind this app's query client and
  // toast.
  const {
    automating,
    capInput,
    setCapInput,
    policyCap,
    beginAutomate,
    closeAutomate,
    confirmGrant,
    policyBusy,
    livePolicies,
    policyByKind,
    pausedCount,
  } = useActionPolicyControls<
    ActionProposal,
    ClerkActionPolicy,
    AutomatableActionKind
  >({
    clientPartyId,
    policies,
    grant,
    pause,
    resume,
    revoke,
    automatableKind: automatableActionKind,
    parseCap: parsePolicyCap,
    defaultCap: POLICY_CAP_DEFAULT,
  });
  // "Your own record" for the kind being granted: shown ABOVE the consent
  // sentence so the decision is evidence-backed. Null (no backtest entry or
  // an empty sample) renders nothing — no placeholder, no gating.
  const automatingKind = automating
    ? automatableActionKind(automating.kind)
    : null;
  const automatingEvidenceLine = automatingKind
    ? policyEvidenceLine(
        automatingKind,
        evidence?.kinds.find((k) => k.kind === automatingKind),
      )
    : null;
  const dialog = useClerkActionsDialog<
    ActionProposal,
    ClerkActionDecision,
    PaymentChaserDraft
  >({
    mutation: execute,
    run: async (action) => {
      const res = await execute.mutateAsync({
        data: {
          kind: action.kind,
          invoiceIds: action.targets.map((t) => t.invoiceId),
          clientPartyId,
        },
      });
      return { decision: res.decision, drafts: res.drafts };
    },
    onExecuted: () => {
      // Not awaited: a background refetch rejection must not surface as a
      // false "action failed" error after the batch already ran. The
      // no-args keys prefix-match every param variant. The proposals and
      // decisions queries are deliberately NOT here — see the hook's
      // onCloseAfterDecision (the F1 rule).
      queryClient.invalidateQueries({ queryKey: getListInvoicesQueryKey() });
      queryClient.invalidateQueries({
        queryKey: getGetDashboardSummaryQueryKey(),
      });
      queryClient.invalidateQueries({
        queryKey: getGetReceivablesSummaryQueryKey(),
      });
      queryClient.invalidateQueries({
        queryKey: getGetPenaltyExposureQueryKey(),
      });
      queryClient.invalidateQueries({
        queryKey: getGetMonthEndCloseQueryKey(),
      });
    },
    onCloseAfterDecision: () => {
      queryClient.invalidateQueries({
        queryKey: getGetActionProposalsQueryKey(),
      });
      queryClient.invalidateQueries({
        queryKey: getGetActionDecisionsQueryKey(),
      });
    },
    onError: (e) =>
      toast({
        title: "Action failed",
        description: serverErrorMessage(e),
        variant: "destructive",
      }),
  });
  const { confirming, decision, drafts, closeDialog } = dialog;
  // The card must survive the proposals list emptying: after a full batch
  // submits, the refetched list is [] and an early return would unmount the
  // OPEN results view mid-read (review F1) — so the card stays mounted while
  // the dialog is up. A live standing approval also keeps the card up — it
  // must stay manageable on a quiet day — and so does run history (round
  // 29): the owner's evidence of what automation did must not vanish just
  // because today's batch already ran.
  const hasDecisions = (decisions?.decisions.length ?? 0) > 0;
  if (
    !isSuccess ||
    !proposals ||
    (proposals.actions.length === 0 &&
      !dialog.dialogOpen &&
      livePolicies.length === 0 &&
      !hasDecisions)
  ) {
    return null;
  }

  return (
    <Card data-testid="clerk-actions">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="w-5 h-5" aria-hidden="true" /> Clerk suggests
          {pausedCount > 0 && (
            <span
              className={`ml-auto ${summaryPillClasses("amber")}`}
              data-testid="pill-automation-paused"
            >
              {pausedCount} paused
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* A quiet day with automation or history to show: say why the card
            is otherwise silent instead of opening straight on the strips. */}
        {proposals.actions.length === 0 &&
          (livePolicies.length > 0 || hasDecisions) && (
            <p
              className="text-sm text-muted-foreground"
              data-testid="text-actions-empty"
            >
              Nothing to suggest right now — automation and history below.
            </p>
          )}
        {proposals.actions.map((action) => (
          <div key={action.kind} className="space-y-2" data-testid={`action-${action.kind}`}>
            <p className="font-medium">{action.title}</p>
            <p className="text-sm text-muted-foreground">{action.why}</p>
            <div className="space-y-1 text-xs text-muted-foreground">
              {action.targets.slice(0, ACTION_TARGET_DISPLAY_CAP).map((t) => (
                <p key={t.invoiceId} data-testid={`action-target-${t.invoiceId}`}>
                  {t.invoiceNumber} · issued {formatDate(t.issueDate)}
                  {action.kind === "submit_overdue" && (
                    <>
                      {" "}
                      · {t.daysOverdue} day{t.daysOverdue === 1 ? "" : "s"} past
                      the window
                    </>
                  )}
                  {t.grandTotal
                    ? ` · ${formatAmount(t.grandTotal, t.currency)}`
                    : ""}
                  {t.note ? ` · ${t.note}` : ""}
                </p>
              ))}
              {action.targets.length > ACTION_TARGET_DISPLAY_CAP && (
                <p>{actionTargetOverflowNote(action.targets.length)}</p>
              )}
              {action.truncated && (
                <p>
                  {actionTruncatedNote(
                    action.targets.length,
                    action.targetCount,
                  )}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={() => dialog.beginConfirm(action)}
                disabled={execute.isPending}
                data-testid={`button-approve-${action.kind}`}
              >
                <Send className="w-4 h-4 mr-2" aria-hidden="true" />
                Review &amp; approve
              </Button>
              {/* The automate affordance: submit kinds only, flag lit, no
                  live grant yet — a standing approval is granted NEXT TO the
                  evidence it will act on. */}
              {policies?.enabled &&
                automatableActionKind(action.kind) &&
                !policyByKind.has(action.kind) && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => beginAutomate(action)}
                    disabled={policyBusy}
                    data-testid={`button-automate-${action.kind}`}
                  >
                    Automate daily
                  </Button>
                )}
            </div>
          </div>
        ))}
        {livePolicies.length > 0 && (
          <div className="space-y-2 border-t pt-3">
            <p className="font-medium text-sm">Automation</p>
            {livePolicies.map((p) => (
              <div
                key={p.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
                data-testid={`policy-${p.kind}`}
              >
                <span className="font-medium text-foreground">
                  {policyKindLabel(p.kind)}
                </span>
                <span
                  className={
                    p.pausedAt
                      ? "text-amber-700 dark:text-amber-400"
                      : "text-muted-foreground"
                  }
                  data-testid={`text-policy-status-${p.kind}`}
                >
                  {policyStatusLine(p)}
                </span>
                <span className="ml-auto flex gap-1">
                  {p.pausedAt ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => resume.mutate({ id: p.id })}
                      disabled={policyBusy}
                      data-testid={`button-policy-resume-${p.kind}`}
                    >
                      Resume
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => pause.mutate({ id: p.id })}
                      disabled={policyBusy}
                      data-testid={`button-policy-pause-${p.kind}`}
                    >
                      Pause
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => revoke.mutate({ id: p.id })}
                    disabled={policyBusy}
                    data-testid={`button-policy-revoke-${p.kind}`}
                  >
                    Revoke
                  </Button>
                </span>
              </div>
            ))}
          </div>
        )}
        {hasDecisions && (
          <div className="space-y-1 border-t pt-3 text-xs text-muted-foreground">
            <p className="font-medium text-foreground text-sm">
              Recent activity
            </p>
            {decisions?.decisions.slice(0, 5).map((d) => (
              <p key={d.id} data-testid={`decision-${d.id}`}>
                {decisionLine(d)}
              </p>
            ))}
          </div>
        )}
        <p className="text-xs text-muted-foreground pt-3 border-t">
          {proposals.note}
        </p>
      </CardContent>
      <Dialog open={!!confirming} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          {decision === null ? (
            <>
              <DialogHeader>
                <DialogTitle>Approve: {confirming?.title}</DialogTitle>
                <DialogDescription>
                  {confirming
                    ? actionConfirmDescription(
                        confirming.kind,
                        confirming.targets.length,
                        "sme",
                      )
                    : ""}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={closeDialog}
                  disabled={execute.isPending}
                >
                  Cancel
                </Button>
                <Button
                  onClick={() => confirming && dialog.runAction(confirming)}
                  disabled={execute.isPending}
                  data-testid="button-confirm-action"
                >
                  {execute.isPending
                    ? "Working…"
                    : confirming
                      ? actionConfirmButtonLabel(
                          confirming.kind,
                          confirming.targets.length,
                        )
                      : ""}
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Batch result</DialogTitle>
                <DialogDescription data-testid="text-action-outcome">
                  {actionOutcomeSummary(decision)}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-1 text-sm">
                {decision.targets.map((t) => (
                  <p
                    key={t.invoiceId}
                    className="flex justify-between gap-3"
                    data-testid={`outcome-${t.invoiceId}`}
                  >
                    <span className="truncate">{t.invoiceNumber}</span>
                    <span className={actionOutcomeToneClasses(t.outcome)}>
                      {ACTION_OUTCOME_LABELS[t.outcome] ?? t.outcome}
                      {t.error ? ` — ${t.error}` : ""}
                    </span>
                  </p>
                ))}
              </div>
              {drafts && drafts.length > 0 && (
                <div className="space-y-3 border-t pt-3">
                  <p className="text-sm font-medium">
                    Your drafted reminders — copy each into your own email.
                    This dialog will not show them again: copy them before
                    closing.
                  </p>
                  {drafts.map((d) => (
                    <div
                      key={d.invoiceId}
                      className="rounded-md border p-3 space-y-1.5 text-sm"
                      data-testid={`draft-${d.invoiceId}`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <p className="font-medium truncate">{d.subject}</p>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            navigator.clipboard.writeText(
                              draftClipboardText(d),
                            )
                          }
                          data-testid={`button-copy-draft-${d.invoiceId}`}
                        >
                          Copy
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {d.invoiceNumber} · to {d.buyerName} · reminder #
                        {d.stage}
                      </p>
                      <p className="whitespace-pre-wrap text-xs">{d.body}</p>
                    </div>
                  ))}
                </div>
              )}
              <DialogFooter>
                <Button onClick={closeDialog} data-testid="button-close-action">
                  Done
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
      {/* Standing-approval confirm: consent-grade copy, separate from the
          per-batch dialog machine (granting runs no batch). */}
      <Dialog
        open={!!automating}
        onOpenChange={(open) => !open && closeAutomate()}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {automating ? policyKindLabel(automating.kind) : ""}
            </DialogTitle>
            {/* The client's own backtest, before the consent sentence —
                absent entirely when there is no evidence to show. */}
            {automatingEvidenceLine && (
              <p
                className="text-sm text-muted-foreground"
                data-testid="text-policy-evidence"
              >
                {automatingEvidenceLine}
              </p>
            )}
            <DialogDescription>
              {/* The consent copy restates the ceiling being chosen below;
                  while the box is mid-edit (invalid) it reads the default
                  and the confirm button is disabled anyway. */}
              {automating
                ? policyGrantDescription(
                    automating.kind,
                    "sme",
                    policyCap ?? POLICY_CAP_DEFAULT,
                  )
                : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="policy-cap">Daily limit (invoices per run)</Label>
            <Input
              id="policy-cap"
              type="number"
              inputMode="numeric"
              min={POLICY_CAP_MIN}
              max={POLICY_CAP_MAX}
              value={capInput}
              onChange={(e) => setCapInput(e.target.value)}
              data-testid="input-policy-cap"
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={closeAutomate}
              disabled={grant.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={confirmGrant}
              disabled={grant.isPending || policyCap === null}
              data-testid="button-confirm-automate"
            >
              {grant.isPending ? "Working…" : "Turn on daily automation"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
