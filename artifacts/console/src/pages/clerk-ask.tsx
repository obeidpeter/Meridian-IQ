import type { ClerkAnswer } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  BookOpenCheck,
  CheckCircle2,
  ChevronRight,
  MessageCircleQuestion,
  Send,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

const QUICK_QUESTIONS = [
  {
    label: "Standard VAT rate",
    question: "What VAT rate applies to consulting services?",
  },
  {
    label: "B2C reporting deadline",
    question: "What is the B2C reporting deadline?",
  },
  {
    label: "Section 104 penalty",
    question: "What penalty applies under section 104?",
  },
];

function AnswerCard({ answer }: { answer: ClerkAnswer }) {
  if (!answer.answered) {
    return (
      <Alert
        className="rounded-lg border-amber-200 bg-amber-50/70 p-5 text-amber-950 shadow-sm dark:border-amber-900 dark:bg-amber-950/20 dark:text-amber-100"
        data-testid="card-clerk-refusal"
      >
        <ShieldCheck className="h-4 w-4" aria-hidden="true" />
        <AlertTitle>No approved answer found</AlertTitle>
        <AlertDescription className="mt-1 text-amber-900/75 dark:text-amber-100/70">
          {answer.refusalReason}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <section
      className="overflow-hidden rounded-lg border bg-card shadow-sm"
      data-testid="card-clerk-answer"
    >
      <header className="flex items-center gap-3 border-b bg-emerald-50/70 px-5 py-4 dark:bg-emerald-950/20">
        <span className="grid size-9 place-items-center rounded-md bg-emerald-600 text-white">
          <CheckCircle2 className="size-4" aria-hidden="true" />
        </span>
        <div>
          <p className="text-sm font-semibold">Register answer</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Approved claim matched
          </p>
        </div>
      </header>

      <div className="space-y-5 p-5 sm:p-6">
        <p className="text-lg font-medium leading-7 text-foreground">
          {answer.proposition}
        </p>

        {answer.facts && answer.facts.length > 0 && (
          <div className="divide-y overflow-hidden rounded-lg border text-sm">
            {answer.facts.map((fact) => (
              <div
                key={fact.key}
                className="grid gap-1 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-4"
              >
                <span className="text-muted-foreground">{fact.label}</span>
                <span className="font-semibold tabular-nums">
                  {fact.value}
                  {fact.unit ? ` ${fact.unit}` : ""}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <footer className="flex flex-col gap-2 border-t bg-muted/20 px-5 py-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <span className="inline-flex min-w-0 items-center gap-2">
          <BookOpenCheck
            className="size-3.5 shrink-0 text-primary"
            aria-hidden="true"
          />
          <span className="truncate">Source: {answer.citation}</span>
        </span>
        <span className="shrink-0">
          <code>{answer.claimKey}</code> v{answer.claimVersion}
        </span>
      </footer>
    </section>
  );
}

// The question state and mutation stay in ClerkWorkspace because inactive tab
// content unmounts. This component is intentionally presentational.
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
    <div className="space-y-4">
      <section className="overflow-hidden rounded-lg border bg-card shadow-sm">
        <div className="grid lg:grid-cols-[minmax(0,1fr)_15rem]">
          <div className="p-5 sm:p-6">
            <div className="flex items-start gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground">
                <MessageCircleQuestion className="size-5" aria-hidden="true" />
              </span>
              <div>
                <h2 className="text-base font-semibold">
                  Ask the claims register
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Nigerian tax and e-invoicing rules
                </p>
              </div>
            </div>

            <Textarea
              className="mt-5 min-h-32 resize-y text-base leading-6"
              value={question}
              onChange={(event) => onQuestionChange(event.target.value)}
              placeholder="Ask a compliance question..."
              rows={4}
              data-testid="input-ask-question"
            />

            <div className="mt-3 flex flex-wrap gap-2">
              {QUICK_QUESTIONS.map(({ label, question: prompt }) => (
                <button
                  key={label}
                  type="button"
                  className="inline-flex min-h-8 items-center gap-1 rounded-md border bg-background px-2.5 text-left text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => onQuestionChange(prompt)}
                >
                  <span>{label}</span>
                  <ChevronRight
                    className="size-3 shrink-0"
                    aria-hidden="true"
                  />
                </button>
              ))}
            </div>

            <div className="mt-5 flex justify-end border-t pt-4">
              <Button
                className="w-full sm:w-auto"
                onClick={onAsk}
                disabled={question.trim().length < 3 || isPending}
                data-testid="button-ask"
              >
                {isPending ? (
                  <Sparkles className="size-4" aria-hidden="true" />
                ) : (
                  <Send className="size-4" aria-hidden="true" />
                )}
                {isPending ? "Checking register..." : "Ask Clerk"}
              </Button>
            </div>
          </div>

          <aside className="border-t border-[#16494a] bg-[#082728] p-5 text-white lg:border-l lg:border-t-0">
            <ShieldCheck className="size-5 text-lime-300" aria-hidden="true" />
            <p className="mt-3 text-sm font-semibold">Grounding active</p>
            <div className="mt-5 space-y-4">
              {[
                "Approved claims only",
                "Citation attached",
                "Unknowns are refused",
              ].map((item) => (
                <div
                  key={item}
                  className="flex items-center gap-2 text-xs text-white/70"
                >
                  <span
                    className="size-1.5 rounded-full bg-lime-300"
                    aria-hidden="true"
                  />
                  {item}
                </div>
              ))}
            </div>
          </aside>
        </div>
      </section>

      {answer && <AnswerCard answer={answer} />}
    </div>
  );
}
