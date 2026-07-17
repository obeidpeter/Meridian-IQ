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
import { usePageTitle } from "@/hooks/use-page-title";
import { useToast } from "@/hooks/use-toast";
import { handleClerkGatewayError } from "@/lib/clerk";
import { ShieldCheck } from "lucide-react";

// Register-grounded Q&A for firm principals only (clerk.ask — client_users
// never see this page). Every answer cites an approved claim from the
// compliance register; anything not covered is refused, never improvised.

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
        setPreviousCaseId(row.id);
      },
      onError: (e) =>
        handleClerkGatewayError(e, {
          onDisabled: () => setDisabledBanner(true),
          toast,
          fallbackTitle: "Clerk couldn't take that question",
        }),
    },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Ask Clerk"
        description="Answers come from the approved compliance register or live lookups over your firm's own records — nothing is improvised."
      />

      {disabledBanner && (
        <ClerkDisabledBanner>Please try again later.</ClerkDisabledBanner>
      )}

      <div className="max-w-2xl space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Ask about Nigerian tax rules — or your firm's own numbers
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
              data-testid="input-ask-question"
            />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                Rules come from the approved register; numbers are computed
                live from your firm's records. Anything else is refused and
                escalated rather than guessed.
              </p>
              <Button
                onClick={() =>
                  ask.mutate({
                    data: {
                      question,
                      ...(previousCaseId ? { previousCaseId } : {}),
                    },
                  })
                }
                disabled={question.trim().length < 3 || ask.isPending}
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
