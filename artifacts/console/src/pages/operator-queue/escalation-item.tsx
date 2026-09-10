import { useState } from "react";
import {
  useDraftEscalationReply,
  useReplyToEscalation,
} from "@workspace/api-client-react";
import type { CaseEscalation } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { serverErrorToast } from "@/lib/errors";
import { Sparkles } from "lucide-react";

// One client escalation inside a case card: the reason, the operator's reply
// once sent, and (for operators) a draft-and-send flow. The draft is grounded
// server-side (catalogue fix + attempt history) and lands in an editable
// textarea — nothing goes to the client until the operator sends it.
export function EscalationItem({
  escalation,
  canAct,
  onReplied,
}: {
  escalation: CaseEscalation;
  canAct: boolean;
  onReplied: () => void;
}) {
  const { toast } = useToast();
  const draftReply = useDraftEscalationReply();
  const sendReply = useReplyToEscalation();
  const [reply, setReply] = useState<string | null>(null);
  const [draftSource, setDraftSource] = useState<string | null>(null);
  const [viaExample, setViaExample] = useState(false);

  const handleDraft = () => {
    draftReply.mutate(
      { id: escalation.id },
      {
        onSuccess: (res) => {
          setReply(res.draft);
          setDraftSource(res.source);
          setViaExample(res.viaExample);
        },
        onError: (e) =>
          serverErrorToast(toast, e, {
            title: "Could not draft a reply",
            fallback: "Try again.",
          }),
      },
    );
  };

  const handleSend = () => {
    if (!reply?.trim()) return;
    sendReply.mutate(
      { id: escalation.id, data: { reply: reply.trim() } },
      {
        onSuccess: () => {
          toast({ title: "Reply sent to the client" });
          setReply(null);
          setDraftSource(null);
          setViaExample(false);
          onReplied();
        },
        onError: (e) =>
          serverErrorToast(toast, e, {
            title: "Could not send the reply",
            fallback: "Try again.",
          }),
      },
    );
  };

  return (
    <div className="space-y-1.5" data-testid={`escalation-${escalation.id}`}>
      <p className="text-amber-900/80 dark:text-amber-200/80">
        “{escalation.reason}”
      </p>
      {escalation.operatorReply ? (
        <div className="rounded-md bg-background/60 px-2.5 py-1.5">
          <p className="text-xs font-medium text-muted-foreground">Replied</p>
          <p className="text-foreground/80 whitespace-pre-wrap">
            {escalation.operatorReply}
          </p>
        </div>
      ) : canAct && reply === null ? (
        <Button
          size="sm"
          variant="outline"
          disabled={draftReply.isPending}
          onClick={handleDraft}
          data-testid={`button-draft-reply-${escalation.id}`}
        >
          <Sparkles className="w-3.5 h-3.5 mr-1.5" aria-hidden="true" />
          {draftReply.isPending ? "Drafting…" : "Draft reply"}
        </Button>
      ) : canAct && reply !== null ? (
        <div className="space-y-2">
          <Label
            htmlFor={`operator-reply-${escalation.id}`}
            className="sr-only"
          >
            Reply to escalation
          </Label>
          {draftSource && (
            <p className="text-xs text-muted-foreground">
              {draftSource === "clerk"
                ? `Clerk drafted this from the error playbook and attempt history${viaExample ? ", styled on a reply this desk previously sent for the same code" : ""} — edit before sending.`
                : "Template draft (Clerk unavailable) — edit before sending."}
            </p>
          )}
          <Textarea
            id={`operator-reply-${escalation.id}`}
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            className="min-h-[100px] text-sm bg-background"
            maxLength={2000}
            data-testid={`input-reply-${escalation.id}`}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={sendReply.isPending || !reply.trim()}
              onClick={handleSend}
              data-testid={`button-send-reply-${escalation.id}`}
            >
              {sendReply.isPending ? "Sending…" : "Send reply"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={sendReply.isPending}
              onClick={() => {
                setReply(null);
                setDraftSource(null);
                setViaExample(false);
              }}
              data-testid={`button-discard-reply-${escalation.id}`}
            >
              Discard
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
