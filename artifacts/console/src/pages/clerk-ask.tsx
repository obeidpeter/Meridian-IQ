import { useState } from "react";
import { useAskClerk } from "@workspace/api-client-react";
import type { ClerkAnswer } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ShieldCheck } from "lucide-react";
import { ClerkPageHeader } from "@/components/clerk-shell";
import { usePageTitle } from "@/hooks/use-page-title";

function AnswerCard({ answer }: { answer: ClerkAnswer }) {
  if (!answer.answered) {
    return (
      <Alert data-testid="card-clerk-refusal">
        <ShieldCheck className="h-4 w-4" aria-hidden="true" />
        <AlertTitle>The Clerk declined to answer</AlertTitle>
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
              <div key={f.key} className="flex items-center gap-2 px-3 py-2">
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
            <>
              Source: {answer.citation} · live lookup{" "}
              <code>{answer.dataIntent}</code>
              {answer.dataParams && (
                <>
                  {" · scope: "}
                  {Object.values(answer.dataParams).join(" · ")}
                </>
              )}
            </>
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

// TanStack v5 resets mutation.data the moment the next mutate() starts, so an
// answer rendered straight off the mutation would vanish exactly when the
// operator wants to re-read it — while their follow-up is in flight. The page
// therefore holds the last rendered answer itself: replaced on success
// (refusals included — a refusal IS the newest answer), kept through a
// pending follow-up and kept when the follow-up errors.
export function heldAnswer(
  previous: ClerkAnswer | null,
  outcome:
    | { type: "success"; answer: ClerkAnswer | null | undefined }
    | { type: "error" },
): ClerkAnswer | null {
  return outcome.type === "success" ? (outcome.answer ?? null) : previous;
}

// Routed Ask page inside the Clerk shell. Now that Ask is its own route
// (not an unmounting tab), the question state and the ask mutation live here.
export function ClerkAskPage() {
  usePageTitle("Ask Clerk");
  const ask = useAskClerk();
  const [question, setQuestion] = useState("");
  // The last answer shown, held in component state (see heldAnswer above).
  const [answer, setAnswer] = useState<ClerkAnswer | null>(null);
  // Multi-turn (round 12): the previous answered case threads follow-ups —
  // "and for June?" reuses the last lookup's platform-recorded scope. The
  // server re-verifies the id belongs to this firm before using it.
  const [previousCaseId, setPreviousCaseId] = useState<string | null>(null);
  return (
    <div className="space-y-6">
      <ClerkPageHeader
        eyebrow="Claims register"
        title="Ask Clerk"
        description="Answers come from the approved claims register or live lookups over the firm's own records — nothing is improvised. Follow-ups like “and for June?” carry the previous question's scope."
      />
      <AskPanel
        question={question}
        onQuestionChange={setQuestion}
        onAsk={() =>
          ask.mutate(
            {
              data: {
                question,
                ...(previousCaseId ? { previousCaseId } : {}),
              },
            },
            {
              // Only a DATA answer carries scope worth threading — keeping
              // the last data-answered id preserves the thread across a
              // refusal or register-claim answer in between.
              onSuccess: (row) => {
                setAnswer((prev) =>
                  heldAnswer(prev, { type: "success", answer: row.answer }),
                );
                if (row.answer?.answered && row.answer?.dataIntent) {
                  setPreviousCaseId(row.id);
                }
              },
              // A failed follow-up keeps the previous answer on screen — it
              // is still the newest truth the operator was given.
              onError: () => {
                setAnswer((prev) => heldAnswer(prev, { type: "error" }));
              },
            },
          )
        }
        isPending={ask.isPending}
        answer={answer}
      />
    </div>
  );
}

// Presentational Ask body (props-controlled so it stays unit-testable).
export function AskPanel({
  question,
  onQuestionChange,
  onAsk,
  isPending,
  answer,
}: {
  question: string;
  onQuestionChange: (question: string) => void;
  onAsk: () => void;
  isPending: boolean;
  answer: ClerkAnswer | null | undefined;
}) {
  return (
    <div className="max-w-2xl space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Ask about Nigerian tax rules — or the firm's own numbers
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            value={question}
            onChange={(e) => onQuestionChange(e.target.value)}
            placeholder="What VAT rate applies to a consulting invoice? What is overdue this week?"
            rows={3}
            data-testid="input-ask-question"
          />
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              Rules come from the approved claims register; numbers are
              computed live from the firm's records. Anything else is refused
              and escalated.
            </p>
            <Button
              onClick={onAsk}
              disabled={question.trim().length < 3 || isPending}
              data-testid="button-ask"
            >
              {isPending ? "Checking the register…" : "Ask"}
            </Button>
          </div>
        </CardContent>
      </Card>
      {answer && <AnswerCard answer={answer} />}
    </div>
  );
}
