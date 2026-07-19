import { useState } from "react";
import { Link } from "wouter";
import { useAskClerk } from "@workspace/api-client-react";
import type { ClerkAnswer } from "@workspace/api-client-react";
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
import { dataAnswerScope, handleClerkGatewayError } from "@/lib/clerk";
import { ShieldCheck } from "lucide-react";

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
// from the asker's own records instead of a register refusal.
const SUGGESTED_QUESTIONS = [
  "What's overdue?",
  "What did we submit this month?",
  "What invoices haven't gone out?",
  "Who owes us?",
];

function AnswerCard({ answer }: { answer: ClerkAnswer }) {
  if (!answer.answered) {
    return (
      <Alert data-testid="card-clerk-refusal">
        <ShieldCheck className="h-4 w-4" aria-hidden="true" />
        <AlertTitle>Clerk declined to answer</AlertTitle>
        <AlertDescription>{answer.refusalReason}</AlertDescription>
      </Alert>
    );
  }
  return (
    <Card data-testid="card-clerk-answer">
      <CardContent className="pt-6 space-y-3">
        <p className="text-base">{answer.proposition}</p>
        {answer.facts && answer.facts.length > 0 && (
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
      </CardContent>
    </Card>
  );
}

function AskContent() {
  const { toast } = useToast();
  const [question, setQuestion] = useState("");
  const [disabledBanner, setDisabledBanner] = useState(false);
  // Multi-turn (round 12): follow-ups carry the previous question's scope;
  // the server re-verifies the id belongs to this firm before using it.
  const [previousCaseId, setPreviousCaseId] = useState<string | null>(null);

  const ask = useAskClerk({
    mutation: {
      onSuccess: (row) => {
        setDisabledBanner(false);
        // Only a DATA answer carries scope worth threading — keeping the
        // last data-answered id preserves the thread across a refusal or
        // register-claim answer in between.
        if (row.answer?.answered && row.answer?.dataIntent) {
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
        {ask.data?.answer && <AnswerCard answer={ask.data.answer} />}
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
