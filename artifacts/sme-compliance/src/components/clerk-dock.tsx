import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useAskClerk, type ClerkAnswer } from "@workspace/api-client-react";
import { Bot, ExternalLink, Send, ShieldCheck, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

function pageContext(location: string) {
  if (location.startsWith("/invoices")) return "your invoices";
  if (location.startsWith("/bills")) return "bills and payables";
  if (location.startsWith("/reconciliation")) return "reconciliation";
  if (location.startsWith("/filings")) return "tax filings";
  if (location.startsWith("/obligations")) return "tax obligations";
  if (location.startsWith("/vat")) return "your VAT position";
  return "your business dashboard";
}

function Answer({ answer }: { answer: ClerkAnswer }) {
  if (!answer.answered) {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
        <p className="font-semibold">Clerk declined to answer</p>
        <p className="mt-1 text-xs leading-5">{answer.refusalReason}</p>
      </div>
    );
  }

  const facts =
    answer.sections?.flatMap((section) => section.facts).slice(0, 6) ??
    answer.facts?.slice(0, 6) ??
    [];

  return (
    <div className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-3">
      <p className="text-sm leading-6 text-slate-900">{answer.proposition}</p>
      {facts.length > 0 && (
        <dl className="divide-y divide-slate-200 border-y border-slate-200">
          {facts.map((fact) => (
            <div
              key={fact.key}
              className="flex items-center justify-between gap-4 py-2 text-xs"
            >
              <dt className="text-slate-600">{fact.label}</dt>
              <dd className="font-bold tabular-nums text-slate-950">
                {fact.value}
                {fact.unit ? ` ${fact.unit}` : ""}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <p className="flex items-center gap-1.5 text-[11px] font-semibold text-teal-800">
        <ShieldCheck className="size-3.5" aria-hidden="true" />
        Grounded in approved claims and your live records
      </p>
    </div>
  );
}

export function ClerkDock() {
  const [location, navigate] = useLocation();
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<ClerkAnswer | null>(null);
  const ask = useAskClerk();
  const context = pageContext(location);
  const suggestions = useMemo(() => {
    if (location.startsWith("/invoices")) {
      return [
        "What has not gone out?",
        "What is overdue?",
        "Summarise invoice risk.",
      ];
    }
    if (
      location.startsWith("/filings") ||
      location.startsWith("/obligations")
    ) {
      return [
        "What is due next?",
        "What is overdue?",
        "What should I do today?",
      ];
    }
    return [
      "What is overdue?",
      "What did we submit this month?",
      "How does this month compare?",
    ];
  }, [location]);

  if (location.startsWith("/clerk")) return null;

  const submit = () => {
    const prompt = question.trim();
    if (prompt.length < 3) return;
    ask.mutate(
      { data: { question: prompt } },
      { onSuccess: (row) => setAnswer(row.answer ?? null) },
    );
  };

  return (
    <>
      <Button
        type="button"
        className="fixed bottom-4 right-4 z-40 size-11 gap-2 bg-[#0b6463] px-0 text-white shadow-lg hover:bg-[#084f4e] sm:bottom-5 sm:right-5 sm:h-11 sm:w-auto sm:px-4"
        onClick={() => setOpen(true)}
        aria-label="Ask Clerk"
        title="Ask Clerk"
        data-testid="button-clerk-dock"
      >
        <Sparkles className="size-4" aria-hidden="true" />
        <span className="sr-only sm:not-sr-only">Ask Clerk</span>
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          className="flex w-full flex-col gap-0 p-0 sm:max-w-[28rem]"
        >
          <SheetHeader className="border-b border-slate-200 px-5 py-5 pr-12 text-left">
            <div className="flex items-center gap-3">
              <span className="grid size-9 place-items-center rounded-md bg-[#0b6463] text-white">
                <Bot className="size-5" aria-hidden="true" />
              </span>
              <div>
                <SheetTitle>Clerk AI</SheetTitle>
                <SheetDescription>Working with {context}</SheetDescription>
              </div>
            </div>
          </SheetHeader>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-5">
            <div className="flex flex-wrap gap-2">
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-left text-xs font-semibold text-slate-700 hover:border-teal-300 hover:bg-teal-50"
                  onClick={() => setQuestion(suggestion)}
                >
                  {suggestion}
                </button>
              ))}
            </div>
            {answer && <Answer answer={answer} />}
            {ask.isError && (
              <p className="text-sm text-destructive" role="alert">
                Clerk could not answer that question. Nothing was changed.
              </p>
            )}
          </div>

          <div className="space-y-3 border-t border-slate-200 bg-white p-5">
            <Textarea
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  submit();
                }
              }}
              rows={3}
              placeholder="Ask about invoices, money, filings or deadlines"
              aria-label="Ask Clerk"
            />
            <div className="flex items-center justify-between gap-3">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setOpen(false);
                  navigate("/clerk/ask");
                }}
              >
                Full workspace
                <ExternalLink className="ml-1.5 size-3.5" aria-hidden="true" />
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={submit}
                disabled={question.trim().length < 3 || ask.isPending}
              >
                <Send className="mr-1.5 size-3.5" aria-hidden="true" />
                {ask.isPending ? "Asking…" : "Ask"}
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
