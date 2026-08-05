import { useState } from "react";
import { Link } from "wouter";
import {
  useAskClerk,
  useExecuteAction,
  useSubmitClerkFeedback,
} from "@workspace/api-client-react";
import type {
  AskSectionAction,
  ClerkAnswer,
  ExecuteActionResult,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { CapabilityGate } from "@/components/capability-gate";
import { ClerkDisabledBanner } from "@/components/clerk-disabled-banner";
import { PageHeader } from "@/components/page-header";
import { SuggestedQuestions } from "@/components/suggested-questions";
import { usePageTitle } from "@/hooks/use-page-title";
import { useToast } from "@/hooks/use-toast";
import {
  dataAnswerScope,
  feedbackToSubmit,
  followupPinsLine,
  handleClerkGatewayError,
  holdsFollowupCase,
  invoiceLinks,
  planLine,
  type AskFeedback,
} from "@/lib/clerk";
import { ShieldCheck, ThumbsDown, ThumbsUp, X } from "lucide-react";

// Register-grounded Q&A behind clerk.ask. Firm principals ask across their
// portfolio; since contract 0.36.0 a client_user can ask too, pinned
// server-side to their own business (SEC-03) — the same page serves both,
// and on older servers the capability simply never appears, so the nav and
// gate hide it cleanly. Every answer cites an approved claim from the
// compliance register or a fixed lookup over the asker's own records;
// anything not covered is refused, never improvised.

// AskClerkInput bounds — mirrored client-side so the button and the
// textarea's maxLength agree with what the server will accept.
const QUESTION_MIN = 3;
const QUESTION_MAX = 2000;

// Pre-phrased to land in the grounded data intents, so a first click answers
// from the asker's own records instead of a register refusal. This page
// serves client_users too (SEC-03), who are only offered the
// CLIENT_SAFE_DATA_INTENTS subset (api-server modules/clerk/data-intents/)
// — so every chip here must classify to an intent on THAT allowlist, or the
// chip is a one-click refusal for a client. Check the allowlist before
// adding or rewording a chip.
const SUGGESTED_QUESTIONS = [
  "What's overdue?",
  "What did we submit this month?",
  "What invoices haven't gone out?",
  // data.aged_receivables (client-safe) — not "who owes us?", which lands in
  // data.outstanding_receivables and refuses for client askers.
  "What's been outstanding longest?",
  // The month-over-month delta intent added with Ask 2.0 (contract 0.56.0).
  "How does this month compare to last month?",
];

// Do with Clerk (round 31): the approval block under an action-proposal
// section. Approval drives the EXISTING execute route — the server
// re-asserts capability, the rollout flag, consent and every target at that
// moment, and the decision lands in the append-only ledger. One approval
// per block: the button retires itself into the outcome summary.
function SectionActionApproval({
  action,
  index,
}: {
  action: AskSectionAction;
  index: number;
}) {
  const { toast } = useToast();
  const execute = useExecuteAction();
  const [outcome, setOutcome] = useState<ExecuteActionResult | null>(null);
  if (outcome) {
    const d = outcome.decision;
    return (
      <p className="text-sm" data-testid={`text-action-outcome-${index}`}>
        Approved: {d.executedCount} of {d.requestedCount} ran
        {d.skippedCount > 0 ? `, ${d.skippedCount} no longer eligible` : ""}
        {d.failedCount > 0 ? `, ${d.failedCount} failed` : ""}. The decision
        has been recorded.
      </p>
    );
  }
  return (
    <Button
      size="sm"
      disabled={execute.isPending}
      data-testid={`button-approve-action-${index}`}
      onClick={() =>
        execute.mutate(
          {
            data: {
              kind: action.kind,
              invoiceIds: action.invoiceIds,
              clientPartyId: action.clientPartyId,
            },
          },
          {
            onSuccess: (result) => setOutcome(result),
            onError: () =>
              toast({
                title: "Couldn't run this action",
                description:
                  "Nothing was changed. Review it on the dashboard's actions card, or try again.",
              }),
          },
        )
      }
    >
      {execute.isPending
        ? "Running…"
        : `Approve & run (${action.invoiceIds.length})`}
    </Button>
  );
}

function AnswerCard({
  answer,
  caseId,
}: {
  answer: ClerkAnswer;
  caseId: string | null;
}) {
  const { toast } = useToast();
  // The asker's helpfulness signal, held per answer (the card remounts per
  // case via its key). Optimistic: the thumb fills on press and reverts if
  // the server rejects the write.
  const [feedback, setFeedback] = useState<AskFeedback | null>(null);
  const submitFeedback = useSubmitClerkFeedback();
  const links = invoiceLinks(answer.links);

  const pressFeedback = (pressed: AskFeedback) => {
    if (!caseId || submitFeedback.isPending) return;
    const next = feedbackToSubmit(feedback, pressed);
    if (next == null) return; // same thumb again — the server already knows
    const previous = feedback;
    setFeedback(next);
    submitFeedback.mutate(
      { id: caseId, data: { helpful: next === "helpful" } },
      {
        onError: () => {
          // Quietly: feedback is best-effort, never destructive-toned.
          setFeedback(previous);
          toast({
            title: "Couldn't record your feedback",
            description: "Please try again in a moment.",
          });
        },
      },
    );
  };

  if (!answer.answered) {
    return (
      <Alert data-testid="card-clerk-refusal">
        <ShieldCheck className="h-4 w-4" aria-hidden="true" />
        <AlertTitle>Clerk declined to answer</AlertTitle>
        <AlertDescription>{answer.refusalReason}</AlertDescription>
      </Alert>
    );
  }
  // Multi-intent answers (contract 0.56.0) carry sections — the proposition
  // is a lead-in line and the flat facts are empty. Single-intent answers
  // carry no sections and render the flat fields exactly as before.
  const sections = answer.sections ?? [];
  const hasSections = sections.length > 0;
  const plan = planLine(answer);
  return (
    <Card data-testid="card-clerk-answer">
      <CardContent className="pt-6 space-y-3">
        <p className="text-base">{answer.proposition}</p>
        {/* Plan transparency: which catalogued intents answered, in server
            order — quiet, above the sections. */}
        {plan && (
          <p
            className="text-xs text-muted-foreground"
            data-testid="text-answer-plan"
          >
            {plan}
          </p>
        )}
        {hasSections &&
          sections.map((s, i) => {
            const sectionLinks = invoiceLinks(s.links);
            const scope = dataAnswerScope(s.dataParams);
            return (
              <div
                key={i}
                className="border rounded-md p-3 space-y-2"
                data-testid={`section-answer-${i}`}
              >
                <p className="text-sm font-medium">{s.title}</p>
                <p className="text-sm">{s.text}</p>
                {s.facts.length > 0 && (
                  <div className="border rounded-md divide-y text-sm">
                    {s.facts.map((f) => (
                      <div
                        key={f.key}
                        className="flex items-center gap-2 px-3 py-2"
                        // Section-indexed so the row stays unique when two
                        // sections carry the same fact key (e.g. "count").
                        data-testid={`row-fact-${i}-${f.key}`}
                      >
                        <span className="flex-1">{f.label}</span>
                        <span className="font-medium tabular-nums">
                          {f.value}
                          {f.unit ? ` ${f.unit}` : ""}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {sectionLinks.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-muted-foreground">Open</span>
                    {sectionLinks.map((l) => (
                      <Button key={l.id} asChild size="sm" variant="outline">
                        <Link
                          href={`/invoices/${l.id}`}
                          data-testid={`link-answer-invoice-${l.id}`}
                        >
                          {l.label}
                        </Link>
                      </Button>
                    ))}
                  </div>
                )}
                {s.action && (
                  <SectionActionApproval action={s.action} index={i} />
                )}
                {scope && (
                  <p
                    className="text-xs text-muted-foreground"
                    data-testid={`text-section-scope-${i}`}
                  >
                    {scope}
                  </p>
                )}
              </div>
            );
          })}
        {!hasSections && answer.facts && answer.facts.length > 0 && (
          <div className="border rounded-md divide-y text-sm">
            {answer.facts.map((f) => (
              <div
                key={f.key}
                className="flex items-center gap-2 px-3 py-2"
                data-testid={`row-fact-${f.key}`}
              >
                <span className="flex-1">{f.label}</span>
                <span className="font-medium tabular-nums">
                  {f.value}
                  {f.unit ? ` ${f.unit}` : ""}
                </span>
              </div>
            ))}
          </div>
        )}
        {/* Deep links to the records the answer named: invoice-kind links
            with an id only — anything else was dropped by invoiceLinks. */}
        {!hasSections && links.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Open</span>
            {links.map((l) => (
              <Button key={l.id} asChild size="sm" variant="outline">
                <Link
                  href={`/invoices/${l.id}`}
                  data-testid={`link-answer-invoice-${l.id}`}
                >
                  {l.label}
                </Link>
              </Button>
            ))}
          </div>
        )}
        {hasSections ? (
          // A sectioned answer is data-grounded per section (each block shows
          // its own scope), so the one source line carries the citation only
          // — and only when the server sent one.
          answer.citation ? (
            <p className="text-xs text-muted-foreground">
              <span data-testid="text-answer-from-records">
                From your records · {answer.citation}
              </span>
            </p>
          ) : null
        ) : (
          <p className="text-xs text-muted-foreground">
            {answer.dataIntent ? (
              // Data-grounded answer: computed live from the asker's own
              // records, scoped to the labels the server resolved (a month, a
              // client) — dataParams carries display labels, never ids.
              <span data-testid="text-answer-from-records">
                From your records
                {dataAnswerScope(answer.dataParams)
                  ? ` (${dataAnswerScope(answer.dataParams)})`
                  : ""}{" "}
                · {answer.citation}
              </span>
            ) : (
              <>
                Source: {answer.citation} · approved claim{" "}
                <code>{answer.claimKey}</code> v{answer.claimVersion}
              </>
            )}
          </p>
        )}
        {caseId && (
          <div className="flex items-center gap-1.5 pt-1">
            <span className="text-xs text-muted-foreground">
              Was this helpful?
            </span>
            <Button
              size="sm"
              variant={feedback === "helpful" ? "default" : "ghost"}
              aria-pressed={feedback === "helpful"}
              aria-label="This answer was helpful"
              onClick={() => pressFeedback("helpful")}
              data-testid="button-feedback-helpful"
            >
              <ThumbsUp className="h-4 w-4" aria-hidden="true" />
            </Button>
            <Button
              size="sm"
              variant={feedback === "not_helpful" ? "default" : "ghost"}
              aria-pressed={feedback === "not_helpful"}
              aria-label="This answer was not helpful"
              onClick={() => pressFeedback("not_helpful")}
              data-testid="button-feedback-not-helpful"
            >
              <ThumbsDown className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Exported for the component tests (the page export wraps it in
// CapabilityGate, whose useGetMe needs a live session).
export function AskContent() {
  const { toast } = useToast();
  const [question, setQuestion] = useState("");
  const [disabledBanner, setDisabledBanner] = useState(false);
  // Multi-turn (round 12): follow-ups carry the previous question's scope;
  // the server re-verifies the id belongs to this firm before using it.
  const [previousCaseId, setPreviousCaseId] = useState<string | null>(null);
  // The rendered answer lives in state, NOT ask.data: submitting a follow-up
  // resets the mutation's data, which would blank the very answer being
  // followed up on (and never bring it back if the follow-up errors). Held
  // here it stays visible through the in-flight follow-up, survives a
  // follow-up error, and is replaced only by the next answer.
  const [lastAnswer, setLastAnswer] = useState<ClerkAnswer | null>(null);
  // The answered case's id, held alongside the answer: the feedback thumbs
  // and any deep links act on THIS case, which outlives the mutation's data
  // for the same reason the answer does.
  const [lastCaseId, setLastCaseId] = useState<string | null>(null);

  const ask = useAskClerk({
    mutation: {
      onSuccess: (row) => {
        setDisabledBanner(false);
        // The console Ask page's tested semantic: a success REPLACES the
        // held answer with whatever it carried — a success without an
        // answer payload clears a stale one instead of leaving it on
        // screen; an error (onError below) keeps the previous answer.
        setLastAnswer(row.answer ?? null);
        setLastCaseId(row.answer ? row.id : null);
        // Only an answer carrying scope worth inheriting threads: a data
        // answer, a multi-intent (sections) answer, or pinned scope (Ask
        // 2.0). Keeping the last such id preserves the thread across a
        // refusal or register-claim answer in between.
        if (holdsFollowupCase(row.answer)) {
          setPreviousCaseId(row.id);
        }
      },
      // 503 (kill switch) raises the banner; 429 (monthly allowance) and
      // everything else toast with the server's own words — the same split
      // the capture page uses.
      onError: (e) =>
        handleClerkGatewayError(e, {
          onDisabled: () => setDisabledBanner(true),
          toast,
          fallbackTitle: "Clerk couldn't take that question",
        }),
    },
  });

  // One submit path for the Ask button and the suggested chips. A chip
  // passes its own text because setState hasn't landed yet when it fires.
  const submitQuestion = (raw: string) => {
    const q = raw.trim();
    if (q.length < QUESTION_MIN || q.length > QUESTION_MAX || ask.isPending) {
      return;
    }
    ask.mutate({
      data: {
        question: q,
        // Multi-turn: thread the previous data answer so "and for June?"
        // inherits its scope. The server re-verifies the id is this firm's
        // own answered question before using it.
        ...(previousCaseId ? { previousCaseId } : {}),
      },
    });
  };

  // The visible face of the multi-turn thread: when the held answer pinned a
  // display scope (a month label, a client name), say what a follow-up will
  // keep — and offer a way off the thread. Clearing drops previousCaseId
  // only; the answer stays on screen.
  const pinsLine = previousCaseId ? followupPinsLine(lastAnswer) : "";

  return (
    <div className="space-y-6">
      <PageHeader
        title="Ask Clerk"
        description="Answers come from the approved compliance register or live lookups over your own records — nothing is improvised."
      />

      {disabledBanner && (
        <ClerkDisabledBanner>Please try again later.</ClerkDisabledBanner>
      )}

      <div className="max-w-2xl space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Ask about Nigerian tax rules — or your own numbers
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Label htmlFor="ask-question" className="sr-only">
              Your question
            </Label>
            <Textarea
              id="ask-question"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="What VAT rate applies to a consulting invoice? What is overdue this week?"
              rows={3}
              maxLength={QUESTION_MAX}
              data-testid="input-ask-question"
            />
            {pinsLine && (
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className="rounded-full border px-3 py-1 text-xs text-muted-foreground"
                  data-testid="chip-followup-pins"
                >
                  {pinsLine}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs text-muted-foreground"
                  onClick={() => setPreviousCaseId(null)}
                  aria-label="Start a new topic"
                  data-testid="button-clear-followup"
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                  New topic
                </Button>
              </div>
            )}
            <SuggestedQuestions
              questions={SUGGESTED_QUESTIONS}
              disabled={ask.isPending}
              onPick={(q) => {
                setQuestion(q);
                submitQuestion(q);
              }}
            />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                Rules come from the approved register; numbers are computed
                live from your own records. Anything else is refused and
                escalated rather than guessed.
              </p>
              <Button
                onClick={() => submitQuestion(question)}
                disabled={
                  question.trim().length < QUESTION_MIN || ask.isPending
                }
                data-testid="button-ask"
              >
                {ask.isPending ? "Checking the register…" : "Ask"}
              </Button>
            </div>
          </CardContent>
        </Card>
        {/* Persistent polite live region: the answer arrives asynchronously
            after "Ask", so screen readers hear it without hunting for it. */}
        <div aria-live="polite">
          {lastAnswer && (
            // Keyed by case so the feedback selection resets per answer.
            <AnswerCard
              key={lastCaseId ?? "answer"}
              answer={lastAnswer}
              caseId={lastCaseId}
            />
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Looking to send an invoice instead?{" "}
          <Link href="/clerk" className="text-primary hover:underline">
            Send it to Clerk
          </Link>
          .
        </p>
      </div>
    </div>
  );
}

export function ClerkAsk() {
  usePageTitle("Ask Clerk");
  return (
    <CapabilityGate capability="clerk.ask">
      <AskContent />
    </CapabilityGate>
  );
}
