import { useQueryClient } from "@tanstack/react-query";
import {
  useGetMe,
  useGetActionProposals,
  getGetActionProposalsQueryKey,
  useExecuteAction,
  getGetActionDecisionsQueryKey,
  useGetActionDecisions,
  getGetActionPoliciesQueryKey,
  useGetActionPolicies,
  useGetClientAutomationEvidence,
  getGetClientAutomationEvidenceQueryKey,
  useGrantActionPolicy,
  usePauseActionPolicy,
  useResumeActionPolicy,
  useRevokeActionPolicy,
  getGetClientPortfolioQueryKey,
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

// Proposed actions, firm side (round 22): the SME dashboard card's twin on
// the console client page. Clerk assembles each batch from the same checks
// that power the analytics cards; NOTHING runs until the firm user approves,
// approval executes through the ordinary per-invoice path, and every target
// is re-checked at that moment. Renders when a proposal exists OR the client
// has decision history — a dark clerk_actions flag empties the proposals
// (fail-closed; execution refuses 503 regardless), but past decisions remain
// legitimately visible: the strip is the firm's durable record of who
// approved what. The dialog machine (F1 unmount guard, mid-flight close
// gate, deferred invalidations) is the shared headless core
// (@workspace/web-ui useClerkActionsDialog); the copy is lib/format's.
export function ClerkActionsCard({ clientPartyId }: { clientPartyId: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  // The server gates every write on this card behind invoice.submit
  // (routes/clerk/actions.ts: execute for submit kinds, grant/pause/resume/
  // revoke all assertCan invoice.submit). Mirror that here so a read-only
  // viewer (auditor) sees the status, the paused pill and the run record —
  // but no buttons that could only ever 403.
  const { data: me } = useGetMe();
  const canAct = !!me?.capabilities.includes("invoice.submit");
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
  // Standing approvals (round 28): the client's live grants plus the
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
      queryClient.invalidateQueries({
        queryKey: getGetClientPortfolioQueryKey(clientPartyId),
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

  // The dialog must survive the proposals list emptying after a full batch
  // (the SME card's F1 lesson): stay mounted while the dialog is up, defer
  // the proposals refetch to closeDialog. A live standing approval also
  // keeps the card up — it must stay manageable on a quiet day.
  const hasDecisions = (decisions?.decisions.length ?? 0) > 0;
  if (
    !isSuccess ||
    !proposals ||
    (proposals.actions.length === 0 &&
      !dialog.dialogOpen &&
      !hasDecisions &&
      livePolicies.length === 0)
  ) {
    return null;
  }

  return (
    <Card data-testid="card-clerk-actions">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
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
        {proposals.actions.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Nothing to batch right now — the checks behind the dashboards found
            no overdue, failed or chase-worthy paper for this client.
          </p>
        )}
        {proposals.actions.map((action) => (
          <div
            key={action.kind}
            className="space-y-2"
            data-testid={`action-${action.kind}`}
          >
            <p className="font-medium text-sm">{action.title}</p>
            <p className="text-sm text-muted-foreground">{action.why}</p>
            <div className="space-y-1 text-xs text-muted-foreground">
              {action.targets.slice(0, ACTION_TARGET_DISPLAY_CAP).map((t) => (
                <p key={t.invoiceId} data-testid={`action-target-${t.invoiceId}`}>
                  {t.invoiceNumber} · issued {formatDate(t.issueDate)}
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
            {canAct && (
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
                    live grant yet — a standing approval is granted NEXT TO
                    the evidence it will act on. */}
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
            )}
          </div>
        ))}
        {livePolicies.length > 0 && (
          <div className="space-y-2 border-t pt-3">
            <p className="font-medium text-foreground text-sm">Automation</p>
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
                {canAct && (
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
                )}
              </div>
            ))}
          </div>
        )}
        {hasDecisions && (
          <div className="space-y-1 border-t pt-3 text-xs text-muted-foreground">
            <p className="font-medium text-foreground text-sm">
              Recent decisions
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
                        "console",
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
                    Drafted reminders — copy each for the client to send. This
                    dialog will not show them again: copy them before closing.
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
                            navigator.clipboard.writeText(draftClipboardText(d))
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
                    "console",
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
