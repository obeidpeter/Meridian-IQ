import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useAskClerk, type ClerkAnswer } from "@workspace/api-client-react";
import { ClerkDock as SharedClerkDock } from "@workspace/web-ui";

// The dock body lives in @workspace/web-ui (shared with the SME app); this
// wrapper supplies the console's voice — workspace context, suggestions,
// copy — and wires the ask mutation and navigation.
function workspaceContext(location: string) {
  if (location.startsWith("/clients/")) return "this client workspace";
  if (location.startsWith("/billing")) return "billing";
  if (location.startsWith("/advisory")) return "advisory";
  if (location.startsWith("/pipeline")) return "client onboarding";
  if (location.startsWith("/operator-queue")) return "the operator queue";
  if (location.startsWith("/audit")) return "audit evidence";
  return "the firm portfolio";
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
  const suggestions = useMemo(
    () =>
      location.startsWith("/clients/")
        ? ["What needs attention?", "What is due next?", "Summarise the risk."]
        : [
            "What is overdue?",
            "Which clients need attention?",
            "What changed this month?",
          ],
    [location],
  );

  return (
    <SharedClerkDock
      contextLabel={workspaceContext(location)}
      suggestions={suggestions}
      placeholder="Ask about clients, deadlines, invoices or risk"
      groundingNote="Grounded in approved claims and live firm records"
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
