import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Bot, ExternalLink, Send, ShieldCheck, Sparkles, X } from "lucide-react";

export type ClerkDockFact = {
  key: string;
  label: string;
  value: string;
  unit?: string | null;
};

/** App-agnostic view of a Clerk answer: the wrapper flattens the generated
 * ClerkAnswer shape (sections vs top-level facts) into this before render. */
export type ClerkDockAnswer = {
  answered: boolean;
  refusalReason?: string | null;
  proposition?: string | null;
  facts: ClerkDockFact[];
};

function DockAnswer({
  answer,
  groundingNote,
}: {
  answer: ClerkDockAnswer;
  groundingNote: string;
}) {
  if (!answer.answered) {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
        <p className="font-semibold">Clerk declined to answer</p>
        <p className="mt-1 text-xs leading-5">{answer.refusalReason}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-3">
      <p className="text-sm leading-6 text-slate-900">{answer.proposition}</p>
      {answer.facts.length > 0 && (
        <dl className="divide-y divide-slate-200 border-y border-slate-200">
          {answer.facts.map((fact) => (
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
        {groundingNote}
      </p>
    </div>
  );
}

/**
 * The floating "Ask Clerk" dock: one shared body for every app, with the
 * app-specific voice — where the user is, what to suggest, how the answer
 * is grounded — supplied as props alongside the ask mutation's state. The
 * sheet is a radix dialog styled to match the apps' shadcn sheet so the
 * dock reads identically to every other overlay.
 */
export function ClerkDock({
  contextLabel,
  suggestions,
  placeholder,
  groundingNote,
  answer,
  pending,
  error,
  onAsk,
  onOpenFull,
}: {
  contextLabel: string;
  suggestions: string[];
  placeholder: string;
  groundingNote: string;
  answer: ClerkDockAnswer | null;
  pending: boolean;
  error: boolean;
  onAsk: (question: string) => void;
  onOpenFull: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");

  const submit = () => {
    const prompt = question.trim();
    if (prompt.length < 3) return;
    onAsk(prompt);
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          className="fixed bottom-4 right-4 z-40 inline-flex size-11 items-center justify-center gap-2 whitespace-nowrap rounded-md bg-[#0b6463] px-0 text-sm font-semibold text-white shadow-lg transition-colors hover:bg-[#084f4e] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:bottom-5 sm:right-5 sm:h-11 sm:w-auto sm:px-4"
          aria-label="Ask Clerk"
          title="Ask Clerk"
          data-testid="button-clerk-dock"
        >
          <Sparkles className="size-4" aria-hidden="true" />
          <span className="sr-only sm:not-sr-only">Ask Clerk</span>
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed inset-y-0 right-0 z-50 flex h-full w-full flex-col gap-0 border-l bg-background p-0 shadow-lg transition ease-in-out data-[state=closed]:duration-300 data-[state=open]:duration-500 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:max-w-[28rem]">
          <Dialog.Close className="absolute right-2 top-2 grid size-8 place-items-center rounded-md opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 data-[state=open]:bg-secondary">
            <X className="h-4 w-4" aria-hidden="true" />
            <span className="sr-only">Close</span>
          </Dialog.Close>

          <div className="flex flex-col space-y-2 border-b border-slate-200 px-5 py-5 pr-12 text-left">
            <div className="flex items-center gap-3">
              <span className="grid size-9 place-items-center rounded-md bg-[#0b6463] text-white">
                <Bot className="size-5" aria-hidden="true" />
              </span>
              <div>
                <Dialog.Title className="text-lg font-semibold text-foreground">
                  Clerk AI
                </Dialog.Title>
                <Dialog.Description className="text-sm text-muted-foreground">
                  Working with {contextLabel}
                </Dialog.Description>
              </div>
            </div>
          </div>

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
            {answer && (
              <DockAnswer answer={answer} groundingNote={groundingNote} />
            )}
            {error && (
              <p className="text-sm text-destructive" role="alert">
                Clerk could not answer that question. Nothing was changed.
              </p>
            )}
          </div>

          <div className="space-y-3 border-t border-slate-200 bg-white p-5">
            <textarea
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  submit();
                }
              }}
              rows={3}
              placeholder={placeholder}
              aria-label="Ask Clerk"
              className="flex min-h-[60px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:text-sm"
            />
            <div className="flex items-center justify-between gap-3">
              <button
                type="button"
                className="inline-flex min-h-8 items-center justify-center gap-2 whitespace-nowrap rounded-md border border-transparent bg-transparent px-3 text-xs font-semibold transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                onClick={() => {
                  setOpen(false);
                  onOpenFull();
                }}
              >
                Full workspace
                <ExternalLink className="ml-1.5 size-3.5" aria-hidden="true" />
              </button>
              <button
                type="button"
                className="inline-flex min-h-8 items-center justify-center gap-2 whitespace-nowrap rounded-md border border-primary bg-primary px-3 text-xs font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
                onClick={submit}
                disabled={question.trim().length < 3 || pending}
              >
                <Send className="mr-1.5 size-3.5" aria-hidden="true" />
                {pending ? "Asking…" : "Ask"}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
