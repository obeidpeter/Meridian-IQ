import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useAskClerk, type ClerkAnswer } from "@workspace/api-client-react";
import { ClerkDock as SharedClerkDock } from "@workspace/web-ui";

// The dock body lives in @workspace/web-ui (shared with the console); this
// wrapper supplies the SME app's voice — page context, suggestions, copy —
// and wires the ask mutation and navigation.
function pageContext(location: string) {
  if (location.startsWith("/invoices")) return "your invoices";
  if (location.startsWith("/bills")) return "bills and payables";
  if (location.startsWith("/reconciliation")) return "reconciliation";
  if (location.startsWith("/filings")) return "tax filings";
  if (location.startsWith("/obligations")) return "tax obligations";
  if (location.startsWith("/vat")) return "your VAT position";
  return "your business dashboard";
}

function dockAnswer(answer: ClerkAnswer) {
  return {
    answered: answer.answered,
    refusalReason: answer.refusalReason,
    proposition: answer.proposition,
    facts:
      answer.sections?.flatMap((section) => section.facts).slice(0, 6) ??
      answer.facts?.slice(0, 6) ??
      [],
  };
}

export function ClerkDock() {
  const [location, navigate] = useLocation();
  const [answer, setAnswer] = useState<ClerkAnswer | null>(null);
  const ask = useAskClerk();
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

  // The full Ask workspace already lives at /clerk — the dock would only
  // duplicate it there.
  if (location.startsWith("/clerk")) return null;

  return (
    <SharedClerkDock
      contextLabel={pageContext(location)}
      suggestions={suggestions}
      placeholder="Ask about invoices, money, filings or deadlines"
      groundingNote="Grounded in approved claims and your live records"
      answer={answer ? dockAnswer(answer) : null}
      pending={ask.isPending}
      error={ask.isError}
      onAsk={(question) =>
        ask.mutate(
          { data: { question } },
          { onSuccess: (row) => setAnswer(row.answer ?? null) },
        )
      }
      onOpenFull={() => navigate("/clerk/ask")}
    />
  );
}
