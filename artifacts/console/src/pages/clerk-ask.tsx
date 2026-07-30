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

// Exported for the unit tests (rendered via AskPanel in the page itself).
export function AnswerCard({ answer }: { answer: ClerkAnswer }) {
  if (!answer.answered) {
    return (
      <Alert data-testid="card-clerk-refusal">
        <ShieldCheck className="h-4 w-4" aria-hidden="true" />
        <AlertTitle>The Clerk declined to answer</AlertTitle>
        <AlertDescription>{answer.refusalReason}</AlertDescription>
      </Alert>
    );
  }
  // Multi-intent answers (contract 0.56.0) carry sections — the proposition
  // is a lead-in line and the flat facts are empty. Single-intent answers
  // carry no sections and render the flat fields exactly as before.
  const sections = answer.sections ?? [];
  const hasSections = sections.length > 0;
  const plan = planLine(answer);
  return (
    <Card data-testid="card-clerk-answer">
      <CardContent className="pt-6 space-y-3">
        <p className="text-base">{answer.proposition}</p>
        {/* Plan transparency: which catalogued intents answered, in server
            order — quiet, above the sections. */}
        {plan && (
          <p
            className="text-xs text-muted-foreground"
            data-testid="text-answer-plan"
          >
            {plan}
          </p>
        )}
        {hasSections &&
          sections.map((s, i) => {
            const scope = Object.values(s.dataParams ?? {})
              .filter((v) => v.trim().length > 0)
              .join(" · ");
            return (
              <div
                key={i}
                className="border rounded-md p-3 space-y-2"
                data-testid={`section-answer-${i}`}
              >
                <p className="text-sm font-medium">{s.title}</p>
                <p className="text-sm">{s.text}</p>
                {s.facts.length > 0 && (
                  <div className="border rounded-md divide-y text-sm">
                    {s.facts.map((f) => (
                      <div
                        key={f.key}
                        className="flex items-center gap-2 px-3 py-2"
                        // Section-indexed so the row stays unique when two
                        // sections carry the same fact key (e.g. "count").
                        data-testid={`row-fact-${i}-${f.key}`}
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
                {scope && (
                  <p
                    className="text-xs text-muted-foreground"
                    data-testid={`text-section-scope-${i}`}
                  >
                    scope: {scope}
                  </p>
                )}
              </div>
            );
          })}
        {!hasSections && answer.facts && answer.facts.length > 0 && (
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
        {hasSections ? (
          // A sectioned answer is data-grounded per section (each block shows
          // its own scope), so the one source line carries the citation only
          // — and only when the server sent one.
          answer.citation ? (
            <p className="text-xs text-muted-foreground">
              Source: {answer.citation}
            </p>
          ) : null
        ) : (
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
        )}
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

/**
 * The plan-transparency line over a multi-intent answer (contract 0.56.0):
 * "Answered using: <plan titles joined ' · '>". The titles are app-trusted
 * display strings resolved server-side from the closed intent catalogue and
 * are shown verbatim, in server order, so the line is deterministic. Empty
 * string when the answer carries no plan (single-intent), so the line is
 * simply omitted.
 */
export function planLine(
  answer: Pick<ClerkAnswer, "plan"> | null | undefined,
): string {
  const titles = (answer?.plan ?? [])
    .map((p) => p.title.trim())
    .filter((t) => t.length > 0);
  return titles.length > 0 ? `Answered using: ${titles.join(" · ")}` : "";
}

/**
 * The follow-up chip's label: the scope a threaded follow-up will inherit,
 * read off the held answer's pins. Display labels only — a month label, a
 * client name; the machine pins (monthStart, clientPartyId) never render.
 * Empty string when the answer pins nothing displayable, so the chip is
 * omitted (matching today's UX for plain data answers without pins).
 */
export function followupPinsLine(
  answer: Pick<ClerkAnswer, "pins"> | null | undefined,
): string {
  const labels = [answer?.pins?.monthLabel, answer?.pins?.clientName].filter(
    (v): v is string => typeof v === "string" && v.trim().length > 0,
  );
  return labels.length > 0 ? `Follow-ups keep: ${labels.join(" · ")}` : "";
}

/**
 * Whether an answer holds the multi-turn thread — i.e. whether the page
 * should keep its case id as previousCaseId for the next question. Since
 * contract 0.56.0 that is any ANSWERED reply carrying scope a follow-up
 * could inherit: a data answer (dataIntent), a multi-intent answer
 * (sections), or explicit pins — machine pins included, because the server
 * threads on those even when there is no label to display. Register-claim
 * answers and refusals still don't thread; and because a refusal must not
 * sever an existing thread, this predicate gates SETTING previousCaseId,
 * never clearing it. Kept semantically identical to the SME web app's and
 * the mobile lib's copy.
 */
export function holdsFollowupCase(
  answer: ClerkAnswer | null | undefined,
): boolean {
  if (!answer?.answered) return false;
  if (answer.dataIntent) return true;
  if ((answer.sections?.length ?? 0) > 0) return true;
  return Object.values(answer.pins ?? {}).some(
    (v) => typeof v === "string" && v.trim().length > 0,
  );
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
              // Only an answer carrying scope worth inheriting threads: a
              // data answer, a multi-intent (sections) answer, or pinned
              // scope (Ask 2.0). Keeping the last such id preserves the
              // thread across a refusal or register-claim answer in between.
              onSuccess: (row) => {
                setAnswer((prev) =>
                  heldAnswer(prev, { type: "success", answer: row.answer }),
                );
                if (holdsFollowupCase(row.answer)) {
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
        // The visible face of the multi-turn thread: when the held answer
        // pinned a display scope, say what a follow-up will keep — and offer
        // a way off the thread. Clearing drops previousCaseId only; the
        // answer stays on screen.
        followupPins={previousCaseId ? followupPinsLine(answer) : ""}
        onClearFollowup={() => setPreviousCaseId(null)}
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
  followupPins,
  onClearFollowup,
}: {
  question: string;
  onQuestionChange: (question: string) => void;
  onAsk: () => void;
  isPending: boolean;
  answer: ClerkAnswer | null | undefined;
  /** Non-empty ⇒ show what a threaded follow-up will keep (Ask 2.0 pins). */
  followupPins?: string;
  onClearFollowup?: () => void;
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
            aria-label="Your question"
            data-testid="input-ask-question"
          />
          {followupPins ? (
            <div className="flex flex-wrap items-center gap-2">
              <span
                className="rounded-full border px-3 py-1 text-xs text-muted-foreground"
                data-testid="chip-followup-pins"
              >
                {followupPins}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs text-muted-foreground"
                onClick={onClearFollowup}
                aria-label="Start a new topic"
                data-testid="button-clear-followup"
              >
                New topic
              </Button>
            </div>
          ) : null}
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
      {/* Persistent polite live region: the answer arrives asynchronously
          after "Ask", so screen readers hear it without hunting for it. */}
      <div aria-live="polite">{answer && <AnswerCard answer={answer} />}</div>
    </div>
  );
}
