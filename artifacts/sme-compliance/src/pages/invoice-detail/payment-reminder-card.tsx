import { useState } from "react";
import {
  useDraftPaymentChaser,
  useRecordChaseReminder,
  useListPaymentBehaviour,
  getListPaymentBehaviourQueryKey,
  type Invoice,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Send, Sparkles } from "lucide-react";
import { formatDate, pillClasses } from "@/lib/format";

// Payment-chaser draft (round-9 idea #2): a "chase this" button on an
// outstanding receivable. The letter is drafted server-side from stored
// facts (digest posture — template always answers) and NEVER sent by the
// platform: the client copies it into their own email. The buyer's mined
// payment rhythm renders alongside so the client knows whether this buyer is
// late for THEM before chasing at all. Exported for the component tests
// (copy-logs-once is a ladder invariant: stage escalation keys off the row
// count, so a double log falsely hardens the next reminder's tone).
export function PaymentReminderCard({ invoice }: { invoice: Invoice }) {
  const [copied, setCopied] = useState(false);
  const draft = useDraftPaymentChaser();
  // Chase ladder (round-14 idea #3): copying the draft records it as a SENT
  // reminder, so the NEXT draft escalates its tone. Logged on copy only —
  // drafting alone records nothing.
  const logReminder = useRecordChaseReminder();
  const [loggedStage, setLoggedStage] = useState<number | null>(null);
  const { data: behaviour } = useListPaymentBehaviour(
    { clientPartyId: invoice.supplierPartyId },
    {
      query: {
        queryKey: getListPaymentBehaviourQueryKey({
          clientPartyId: invoice.supplierPartyId,
        }),
        staleTime: 5 * 60_000,
        retry: false,
      },
    },
  );
  const buyerBehaviour = behaviour?.find(
    (b) => b.buyerPartyId === invoice.buyerPartyId,
  );

  const copyDraft = async () => {
    if (!draft.data) return;
    try {
      await navigator.clipboard.writeText(
        `${draft.data.subject}\n\n${draft.data.body}`,
      );
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      // Best-effort ladder log: a failure here never blocks the copy. Only
      // the first copy of a given draft logs — loggedStage guards repeats
      // after the log lands, and isPending guards rapid re-copies while the
      // first log is still in flight (loggedStage only updates onSuccess, so
      // without it a double-click would double-log and falsely escalate the
      // ladder).
      if (loggedStage !== draft.data.stage && !logReminder.isPending) {
        logReminder.mutate(
          { invoiceId: invoice.id },
          { onSuccess: (s) => setLoggedStage(s.stage) },
        );
      }
    } catch {
      // Clipboard denied: the text stays on screen to copy by hand.
    }
  };

  return (
    <Card data-testid="payment-reminder">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Send className="w-4 h-4" aria-hidden="true" /> Awaiting payment
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {buyerBehaviour && (
          <p className="text-muted-foreground" data-testid="payment-rhythm">
            {buyerBehaviour.buyerName} usually pays in about{" "}
            {buyerBehaviour.medianDaysToPay} day(s) (from{" "}
            {buyerBehaviour.settledCount} matched payments).
          </p>
        )}
        {draft.data ? (
          <div className="rounded-lg border bg-background p-3 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="font-medium">{draft.data.subject}</p>
              <span
                className={pillClasses(
                  draft.data.source === "clerk" ? "blue" : "slate",
                )}
              >
                {draft.data.source === "clerk" ? "Clerk-phrased" : "Template"}
              </span>
              <span className={pillClasses("slate")} data-testid="chaser-stage">
                Reminder #{draft.data.stage}
              </span>
            </div>
            {draft.data.previousReminders.count > 0 && (
              <p className="text-xs text-muted-foreground">
                {draft.data.previousReminders.count} earlier reminder
                {draft.data.previousReminders.count === 1 ? "" : "s"} logged
                {draft.data.previousReminders.lastAt
                  ? ` — last on ${formatDate(draft.data.previousReminders.lastAt)}`
                  : ""}
                .
              </p>
            )}
            <p className="whitespace-pre-wrap text-muted-foreground">
              {draft.data.body}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={copyDraft}
                data-testid="button-copy-chaser"
              >
                {copied ? "Copied" : "Copy to clipboard"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  draft.mutate({ data: { invoiceId: invoice.id } })
                }
                disabled={draft.isPending}
              >
                {draft.isPending ? "Redrafting…" : "Redraft"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Review before sending — you send this from your own email; nothing
              is sent for you.
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            <Button
              variant="outline"
              size="sm"
              onClick={() => draft.mutate({ data: { invoiceId: invoice.id } })}
              disabled={draft.isPending}
              data-testid="button-draft-chaser"
            >
              <Sparkles className="w-4 h-4 mr-2" aria-hidden="true" />
              {draft.isPending ? "Drafting…" : "Draft a payment reminder"}
            </Button>
            {draft.isError && (
              <p className="text-xs text-muted-foreground">
                Couldn&apos;t draft a reminder just now — try again in a moment.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---- Submission approvals (maker-checker, contract 0.45.0) -----------------
// A firm can require a second approver before any invoice is submitted for
// stamping. Approvals are recorded facts, so the card shows them to everyone
// who can see the invoice; only firm members can RECORD one, and only while
// the invoice is still submittable (draft/validated, or failed awaiting a
// retry) — the server stays the authority (its 409 carries the real reason,
// e.g. the approver matching the eventual submitter).
