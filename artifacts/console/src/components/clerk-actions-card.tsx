import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetActionProposals,
  getGetActionProposalsQueryKey,
  useExecuteAction,
  getGetActionDecisionsQueryKey,
  useGetActionDecisions,
  getGetClientPortfolioQueryKey,
} from "@workspace/api-client-react";
import type {
  ActionProposal,
  ClerkActionDecision,
  PaymentChaserDraft,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { formatAmount, formatDate, formatDateTime } from "@/lib/format";
import { Send, Sparkles } from "lucide-react";

const TARGET_DISPLAY_CAP = 8;

const OUTCOME_LABELS: Record<string, string> = {
  submitted: "Submitted",
  invalid: "Needs fixing",
  skipped_not_eligible: "Skipped",
  failed: "Failed",
  drafted: "Drafted",
};

// Proposed actions, firm side (round 22): the SME dashboard card's twin on
// the console client page. Clerk assembles each batch from the same checks
// that power the analytics cards; NOTHING runs until the firm user approves,
// approval executes through the ordinary per-invoice path, and every target
// is re-checked at that moment. Renders only when the clerk_actions flag is
// on for the firm AND a proposal exists (a dark flag answers an empty list,
// so the card hides). The recent-decisions strip shows who approved what —
// the durable artifact the SME card only records.
export function ClerkActionsCard({ clientPartyId }: { clientPartyId: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const execute = useExecuteAction();
  const [confirming, setConfirming] = useState<ActionProposal | null>(null);
  const [decision, setDecision] = useState<ClerkActionDecision | null>(null);
  const [drafts, setDrafts] = useState<PaymentChaserDraft[] | null>(null);
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

  // The dialog must survive the proposals list emptying after a full batch
  // (the SME card's F1 lesson): stay mounted while the dialog is up, defer
  // the proposals refetch to closeDialog.
  const dialogOpen = confirming !== null || decision !== null;
  const hasDecisions = (decisions?.decisions.length ?? 0) > 0;
  if (
    !isSuccess ||
    !proposals ||
    (proposals.actions.length === 0 && !dialogOpen && !hasDecisions)
  ) {
    return null;
  }

  const runAction = async (action: ActionProposal) => {
    try {
      const res = await execute.mutateAsync({
        data: {
          kind: action.kind,
          invoiceIds: action.targets.map((t) => t.invoiceId),
          clientPartyId,
        },
      });
      setDecision(res.decision);
      setDrafts(res.drafts ?? null);
      queryClient.invalidateQueries({
        queryKey: getGetClientPortfolioQueryKey(clientPartyId),
      });
    } catch (e) {
      toast({
        title: "Action failed",
        description: serverErrorMessage(e),
        variant: "destructive",
      });
    }
  };

  const closeDialog = () => {
    if (execute.isPending) return;
    if (decision !== null) {
      queryClient.invalidateQueries({
        queryKey: getGetActionProposalsQueryKey(),
      });
      queryClient.invalidateQueries({
        queryKey: getGetActionDecisionsQueryKey(),
      });
    }
    setConfirming(null);
    setDecision(null);
    setDrafts(null);
  };

  return (
    <Card data-testid="card-clerk-actions">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="w-5 h-5" aria-hidden="true" /> Clerk suggests
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
              {action.targets.slice(0, TARGET_DISPLAY_CAP).map((t) => (
                <p key={t.invoiceId} data-testid={`action-target-${t.invoiceId}`}>
                  {t.invoiceNumber} · issued {formatDate(t.issueDate)}
                  {t.grandTotal
                    ? ` · ${formatAmount(t.grandTotal, t.currency)}`
                    : ""}
                  {t.note ? ` · ${t.note}` : ""}
                </p>
              ))}
              {action.targets.length > TARGET_DISPLAY_CAP && (
                <p>…and {action.targets.length - TARGET_DISPLAY_CAP} more.</p>
              )}
              {action.truncated && (
                <p>
                  Showing the oldest {action.targets.length} of{" "}
                  {action.targetCount} — approve this batch, then come back for
                  the rest.
                </p>
              )}
            </div>
            <Button
              size="sm"
              onClick={() => setConfirming(action)}
              disabled={execute.isPending}
              data-testid={`button-approve-${action.kind}`}
            >
              <Send className="w-4 h-4 mr-2" aria-hidden="true" />
              Review &amp; approve
            </Button>
          </div>
        ))}
        {hasDecisions && (
          <div className="space-y-1 border-t pt-3 text-xs text-muted-foreground">
            <p className="font-medium text-foreground text-sm">
              Recent decisions
            </p>
            {decisions?.decisions.slice(0, 5).map((d) => (
              <p key={d.id} data-testid={`decision-${d.id}`}>
                {formatDateTime(d.createdAt)} · {d.kind} · {d.executedCount}{" "}
                executed · {d.skippedCount} skipped · {d.failedCount} failed
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
                  {confirming?.kind === "draft_chasers"
                    ? `This drafts ${confirming?.targets.length} payment reminder${
                        confirming?.targets.length === 1 ? "" : "s"
                      } for the client to review and send — nothing is sent or submitted by the platform. Each invoice is re-checked at this moment, and the decision is recorded under your name.`
                    : `This ${confirming?.kind === "retry_failed" ? "resubmits" : "submits"} ${confirming?.targets.length} invoice${
                        confirming?.targets.length === 1 ? "" : "s"
                      } to the e-invoicing rails through the ordinary path — validation, consent and any approval policy all apply. Each invoice is re-checked at this moment; anything already processed or no longer eligible is skipped, and the decision is recorded under your name.`}
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
                  onClick={() => confirming && runAction(confirming)}
                  disabled={execute.isPending}
                  data-testid="button-confirm-action"
                >
                  {execute.isPending
                    ? "Working…"
                    : `Approve ${confirming?.targets.length ?? 0} invoice${
                        confirming?.targets.length === 1 ? "" : "s"
                      }`}
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Batch result</DialogTitle>
                <DialogDescription data-testid="text-action-outcome">
                  {decision.executedCount}{" "}
                  {decision.kind === "draft_chasers" ? "drafted" : "submitted"} ·{" "}
                  {decision.failedCount} need attention ·{" "}
                  {decision.skippedCount} skipped.
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
                    <span
                      className={
                        t.outcome === "submitted" || t.outcome === "drafted"
                          ? "text-emerald-700 dark:text-emerald-400"
                          : t.outcome === "skipped_not_eligible"
                            ? "text-muted-foreground"
                            : "text-amber-700 dark:text-amber-400"
                      }
                    >
                      {OUTCOME_LABELS[t.outcome] ?? t.outcome}
                      {t.error ? ` — ${t.error}` : ""}
                    </span>
                  </p>
                ))}
              </div>
              {drafts && drafts.length > 0 && (
                <div className="space-y-3 border-t pt-3">
                  <p className="text-sm font-medium">
                    Drafted reminders — copy each for the client to send. They
                    are not stored: copy them before closing.
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
                              `${d.subject}\n\n${d.body}`,
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
    </Card>
  );
}
