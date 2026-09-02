import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useAskClerk, type ClerkAnswer } from "@workspace/api-client-react";
import { ClerkDock as SharedClerkDock } from "@workspace/web-ui";
import { dockAnswerView, dockErrorMessage } from "@/lib/clerk-dock";

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
  return dockAnswerView(answer);
}

export function ClerkDock() {
  const [location, navigate] = useLocation();
  const [answer, setAnswer] = useState<ClerkAnswer | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
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
      errorMessage={errorMessage}
      onAsk={(question) =>
        ask.mutate(
          { data: { question } },
          {
            onSuccess: (row) => {
              setErrorMessage(null);
              setAnswer(row.answer ?? null);
            },
            onError: (e) => setErrorMessage(dockErrorMessage(e)),
          },
        )
      }
      onOpenFull={() => navigate("/clerk/ask")}
    />
  );
}
