import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Bot,
  ExternalLink,
  Send,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";

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
  /** Where the answer came from, phrased by the app exactly as its full Ask
   *  page does (citation, resolved scope, claim key/version). Falls back to
   *  the app's static grounding note when absent. */
  sourceLine?: string | null;
  /** True when the dock view dropped something — facts past its cap, deep
   *  links, section titles or proposed actions — so it can point at the
   *  full workspace instead of implying this is everything. */
  hasMore?: boolean;
};

function DockAnswer({
  answer,
  groundingNote,
  onMore,
}: {
  answer: ClerkDockAnswer;
  groundingNote: string;
  onMore: () => void;
}) {
  if (!answer.answered) {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
        <p className="font-semibold">Clerk declined to answer</p>
        <p className="mt-1 text-xs leading-5">{answer.refusalReason}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3 border-y border-[var(--mi-line)] bg-[var(--mi-canvas)] p-3">
      <p className="text-sm leading-6 text-[var(--mi-ink)]">
        {answer.proposition}
      </p>
      {answer.facts.length > 0 && (
        <dl className="divide-y divide-[var(--mi-line)] border-y border-[var(--mi-line)]">
          {answer.facts.map((fact) => (
            <div
              key={fact.key}
              className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs"
            >
              <dt className="text-[var(--mi-muted)]">{fact.label}</dt>
              <dd className="font-semibold tabular-nums text-[var(--mi-ink)]">
                {fact.value}
                {fact.unit ? ` ${fact.unit}` : ""}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <p
        className="flex items-start gap-1.5 text-[11px] font-medium leading-5 text-primary"
        data-testid="text-dock-source"
      >
        <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        {answer.sourceLine ?? groundingNote}
      </p>
      {answer.hasMore && (
        <button
          type="button"
          onClick={onMore}
          className="min-h-11 rounded-sm text-left text-xs font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          data-testid="button-dock-more"
        >
          More detail and proposed actions in the full workspace
        </button>
      )}
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
  errorMessage,
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
  /** Why the last ask failed, in the app's words (kill switch, monthly
   *  allowance, the server's own message). The generic line is the
   *  fallback when the app passes nothing. */
  errorMessage?: string | null;
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
          className="fixed bottom-4 right-4 z-40 inline-flex size-11 items-center justify-center gap-2 whitespace-nowrap rounded-md border border-primary bg-primary px-0 text-sm font-medium text-primary-foreground shadow-none transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:bottom-5 sm:right-5 sm:h-11 sm:w-auto sm:px-4"
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
        <Dialog.Content className="mi-platform fixed inset-y-0 right-0 z-50 flex h-full w-full flex-col gap-0 border-l border-[var(--mi-line)] bg-[var(--mi-paper)] p-0 [overflow-wrap:anywhere] shadow-[var(--mi-shadow)] transition ease-in-out data-[state=closed]:duration-300 data-[state=open]:duration-500 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:max-w-[28rem]">
          <Dialog.Close
            title="Close"
            className="absolute right-2 top-2 grid size-11 place-items-center rounded-md text-[var(--mi-muted)] ring-offset-background transition-colors hover:bg-[var(--mi-canvas)] hover:text-[var(--mi-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <X className="h-4 w-4" aria-hidden="true" />
            <span className="sr-only">Close</span>
          </Dialog.Close>

          <div className="flex flex-col space-y-2 border-b border-[var(--mi-line)] px-5 py-5 pr-16 text-left">
            <div className="flex min-w-0 items-center gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground">
                <Bot className="size-5" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <Dialog.Title className="text-lg font-semibold text-[var(--mi-ink)]">
                  Clerk AI
                </Dialog.Title>
                <Dialog.Description className="text-sm leading-5 text-[var(--mi-muted)]">
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
                  disabled={pending}
                  className="min-h-11 rounded-md border border-[var(--mi-input-line)] bg-[var(--mi-paper)] px-3 py-2 text-left text-xs font-medium leading-5 text-[var(--mi-ink)] hover:bg-[var(--mi-canvas)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-60"
                  onClick={() => {
                    setQuestion(suggestion);
                    onAsk(suggestion);
                  }}
                >
                  {suggestion}
                </button>
              ))}
            </div>
            <div aria-live="polite" className="space-y-4">
              {answer && (
                <DockAnswer
                  answer={answer}
                  groundingNote={groundingNote}
                  onMore={() => {
                    setOpen(false);
                    onOpenFull();
                  }}
                />
              )}
              {(error || errorMessage) && (
                <p
                  className="text-sm text-destructive"
                  role="alert"
                  data-testid="text-dock-error"
                >
                  {errorMessage ??
                    "Clerk could not answer that question. Nothing was changed."}
                </p>
              )}
            </div>
          </div>

          <div className="space-y-3 border-t border-[var(--mi-line)] bg-[var(--mi-paper)] p-5">
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
              className="flex min-h-[60px] w-full rounded-md border border-input bg-[var(--mi-paper)] px-3 py-2 text-base text-[var(--mi-ink)] shadow-none placeholder:text-[var(--mi-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-sm"
            />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <button
                type="button"
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-transparent bg-transparent px-3 py-2 text-xs font-medium text-[var(--mi-ink)] transition-colors hover:bg-[var(--mi-canvas)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
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
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-primary bg-primary px-3 py-2 text-xs font-medium text-primary-foreground shadow-none transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
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
