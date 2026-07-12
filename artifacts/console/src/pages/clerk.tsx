import { useState } from "react";
import { Link, useLocation } from "wouter";
import {
  useGetMe,
  useListClerkCases,
  useCreateClerkCase,
  useAskClerk,
  useExplainRejection,
  getListClerkCasesQueryKey,
} from "@workspace/api-client-react";
import type { ClerkAnswer, ClerkExplanation } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { FeatureUnavailable } from "@/components/feature-unavailable";
import { QueryError } from "@/components/query-error";
import { useToast } from "@/hooks/use-toast";
import { usePageTitle } from "@/hooks/use-page-title";
import { isFeatureDisabled, serverErrorMessage } from "@/lib/errors";
import {
  clerkCaseStateBadgeClasses,
  clerkCaseStateLabel,
  formatDate,
  humanize,
  isClerkCaseTerminal,
  pillClasses,
  priorityBadgeClasses,
} from "@/lib/format";
import {
  Bot,
  BookOpen,
  FilePlus2,
  Inbox,
  Quote,
  ShieldAlert,
  Sparkles,
} from "lucide-react";

// Clerk workspace (Clerk Supplemental TRD, C1 posture): the operator's view of
// the controlled AI compliance operator — intake queue, manual case capture,
// and the register-only Q&A surface. Everything behind the `clerk` flag.

function truncateId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 12)}…` : id;
}

// ---- Ask Clerk ---------------------------------------------------------------

function AnswerCard({ answer }: { answer: ClerkAnswer }) {
  if (answer.outcome === "refused") {
    return (
      <div
        className="rounded-md bg-muted/60 p-4 space-y-2"
        data-testid="card-clerk-refusal"
      >
        <p className="font-medium flex items-center gap-2 text-sm">
          <ShieldAlert
            className="w-4 h-4 text-muted-foreground shrink-0"
            aria-hidden="true"
          />
          Clerk refused to answer
        </p>
        {answer.refusalReason && (
          <p className="text-sm text-muted-foreground">{answer.refusalReason}</p>
        )}
        <p className="text-xs text-muted-foreground">
          Clerk never guesses — this goes to a human.
          {answer.escalated ? " An escalation case has been opened." : ""}
        </p>
      </div>
    );
  }
  return (
    <div
      className="rounded-md border border-primary/30 bg-primary/5 p-4 space-y-3"
      data-testid="card-clerk-answer"
    >
      <p className="text-sm" data-testid="text-answer">
        {answer.answer}
      </p>
      {(answer.protectedFacts ?? []).length > 0 && (
        <div className="flex flex-wrap gap-2">
          {(answer.protectedFacts ?? []).map((f) => (
            <span
              key={f.key}
              className={pillClasses("blue")}
              data-testid={`fact-${f.key}`}
            >
              <span className="font-normal text-muted-foreground">
                {f.key}:
              </span>{" "}
              {f.value}
              {f.unit ? ` ${f.unit}` : ""}
            </span>
          ))}
        </div>
      )}
      {answer.citation && (
        <p className="text-sm text-muted-foreground flex items-start gap-1.5">
          <Quote className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
          {answer.citation}
        </p>
      )}
      {answer.claimKey && (
        <p className="text-xs text-muted-foreground font-mono">
          {answer.claimKey} · v{answer.claimVersion ?? "?"}
        </p>
      )}
    </div>
  );
}

function ExplanationCard({ explanation }: { explanation: ClerkExplanation }) {
  if (explanation.outcome === "refused") {
    return (
      <div
        className="rounded-md bg-muted/60 p-4 space-y-2"
        data-testid="card-explain-refusal"
      >
        <p className="font-medium flex items-center gap-2 text-sm">
          <ShieldAlert
            className="w-4 h-4 text-muted-foreground shrink-0"
            aria-hidden="true"
          />
          No grounded explanation
        </p>
        {explanation.refusalReason && (
          <p className="text-sm text-muted-foreground">
            {explanation.refusalReason}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Clerk never guesses — this goes to a human.
        </p>
      </div>
    );
  }
  return (
    <div
      className="rounded-md bg-muted/60 p-4 space-y-1.5"
      data-testid="card-explanation"
    >
      <p className="font-mono text-sm font-semibold flex items-center gap-2">
        <BookOpen className="w-4 h-4 text-primary shrink-0" aria-hidden="true" />
        {explanation.code}
        {explanation.retriable && (
          <span className={`${pillClasses("emerald")} font-sans`}>
            Retriable
          </span>
        )}
      </p>
      <p className="text-sm">
        <span className="font-medium">Cause:</span>{" "}
        <span className="text-muted-foreground">{explanation.cause}</span>
      </p>
      <p className="text-sm">
        <span className="font-medium">Fix:</span>{" "}
        <span className="text-muted-foreground">{explanation.fix}</span>
      </p>
      {explanation.catalogueSource && (
        <p className="text-xs text-muted-foreground">
          Catalogue source: {explanation.catalogueSource}
        </p>
      )}
    </div>
  );
}

export function Clerk() {
  usePageTitle("Clerk workspace");
  const { data: me } = useGetMe();
  const canCreate = (me?.capabilities ?? []).includes("clerk.case.write");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  // Poll the queue only while a case can still move on its own — once
  // everything is terminal (closed/rejected/refused) the interval stops.
  const {
    data: cases,
    isLoading,
    error,
    refetch,
  } = useListClerkCases(undefined, {
    query: {
      queryKey: getListClerkCasesQueryKey(),
      refetchInterval: (query) => {
        const rows = query.state.data;
        if (!rows || rows.length === 0) return false;
        return rows.some((c) => !isClerkCaseTerminal(c.state)) ? 5000 : false;
      },
    },
  });

  // Mutations can also discover the flag is dark mid-session (404).
  const [featureDark, setFeatureDark] = useState(false);

  // New case form.
  const createCase = useCreateClerkCase();
  const [sourceText, setSourceText] = useState("");
  const [clientPartyId, setClientPartyId] = useState("");
  const [filename, setFilename] = useState("");

  // Ask Clerk panel.
  const ask = useAskClerk();
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<ClerkAnswer | null>(null);

  // Explain-a-rejection mini-form.
  const explain = useExplainRejection();
  const [errorCode, setErrorCode] = useState("");
  const [explanation, setExplanation] = useState<ClerkExplanation | null>(null);

  const handleCreate = () => {
    if (!sourceText.trim() || !clientPartyId.trim()) return;
    createCase.mutate(
      {
        data: {
          clientPartyId: clientPartyId.trim(),
          sourceText: sourceText.trim(),
          filename: filename.trim() || undefined,
        },
      },
      {
        onSuccess: (detail) => {
          toast({
            title: "Case captured",
            description: `Extraction ran — the case is ${clerkCaseStateLabel(detail.case.state).toLowerCase()}.`,
          });
          setSourceText("");
          setFilename("");
          queryClient.invalidateQueries({
            queryKey: getListClerkCasesQueryKey(),
          });
          setLocation(`/clerk/cases/${detail.case.id}`);
        },
        onError: (err) => {
          if (isFeatureDisabled(err)) {
            setFeatureDark(true);
            return;
          }
          toast({
            title: "Could not create case",
            description: serverErrorMessage(err),
            variant: "destructive",
          });
        },
      },
    );
  };

  const handleAsk = () => {
    if (question.trim().length < 3) return;
    ask.mutate(
      { data: { question: question.trim() } },
      {
        onSuccess: (res) => setAnswer(res),
        onError: (err) => {
          if (isFeatureDisabled(err)) {
            setFeatureDark(true);
            return;
          }
          toast({
            title: "Could not ask Clerk",
            description: serverErrorMessage(err),
            variant: "destructive",
          });
        },
      },
    );
  };

  const handleExplain = () => {
    if (!errorCode.trim()) return;
    explain.mutate(
      { data: { errorCode: errorCode.trim() } },
      {
        onSuccess: (res) => setExplanation(res),
        onError: (err) => {
          if (isFeatureDisabled(err)) {
            setFeatureDark(true);
            return;
          }
          toast({
            title: "Could not explain the code",
            description: serverErrorMessage(err),
            variant: "destructive",
          });
        },
      },
    );
  };

  if (featureDark || isFeatureDisabled(error)) {
    return (
      <div className="space-y-6">
        <h1
          className="text-2xl md:text-3xl font-bold"
          data-testid="text-page-title"
        >
          Clerk workspace
        </h1>
        <FeatureUnavailable feature="Clerk" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1
          className="text-2xl md:text-3xl font-bold"
          data-testid="text-page-title"
        >
          Clerk workspace
        </h1>
        <p className="text-muted-foreground mt-1">
          Controlled AI intake — extraction into reviewable candidates, with
          every answer grounded in the claims register.
        </p>
      </div>

      <Card data-testid="card-case-queue">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Bot className="w-4 h-4 text-primary" aria-hidden="true" /> Case
            queue
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          ) : error ? (
            <QueryError thing="the Clerk case queue" onRetry={() => refetch()} />
          ) : (cases ?? []).length === 0 ? (
            <div className="py-8 flex flex-col items-center text-center gap-2">
              <Inbox
                className="w-10 h-10 text-muted-foreground"
                aria-hidden="true"
              />
              <p className="font-semibold" data-testid="text-empty-queue">
                No Clerk cases yet
              </p>
              <p className="text-sm text-muted-foreground">
                Capture a source below — extraction proposes field candidates
                for human review.
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>State</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead>Client party</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="sr-only">Open</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(cases ?? []).map((c) => (
                  <TableRow key={c.id} data-testid={`row-case-${c.id}`}>
                    <TableCell>
                      <span className={clerkCaseStateBadgeClasses(c.state)}>
                        {clerkCaseStateLabel(c.state)}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className={priorityBadgeClasses(c.priority)}>
                        {humanize(c.priority)}
                      </span>
                    </TableCell>
                    <TableCell
                      className="font-mono text-xs text-muted-foreground"
                      title={c.clientPartyId}
                    >
                      {truncateId(c.clientPartyId)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(c.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        asChild
                        data-testid={`button-open-case-${c.id}`}
                      >
                        <Link href={`/clerk/cases/${c.id}`}>Open</Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {canCreate && (
        <Card data-testid="card-new-case">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <FilePlus2 className="w-4 h-4 text-primary" aria-hidden="true" />{" "}
              New case
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="clerk-source-text">Source text</Label>
              <Textarea
                id="clerk-source-text"
                rows={5}
                value={sourceText}
                onChange={(e) => setSourceText(e.target.value)}
                placeholder="Paste invoice text (photo/voice intake arrives with a later phase)"
                data-testid="input-source-text"
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="clerk-client-party">Client party id</Label>
                <Input
                  id="clerk-client-party"
                  value={clientPartyId}
                  onChange={(e) => setClientPartyId(e.target.value)}
                  placeholder="party id"
                  data-testid="input-client-party-id"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="clerk-filename">Filename (optional)</Label>
                <Input
                  id="clerk-filename"
                  value={filename}
                  onChange={(e) => setFilename(e.target.value)}
                  placeholder="invoice-jan.txt"
                  data-testid="input-filename"
                />
              </div>
            </div>
            <Button
              onClick={handleCreate}
              disabled={
                createCase.isPending ||
                !sourceText.trim() ||
                !clientPartyId.trim()
              }
              data-testid="button-create-case"
            >
              {createCase.isPending
                ? "Running extraction…"
                : "Capture & extract"}
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card data-testid="card-ask-clerk">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-primary" aria-hidden="true" />{" "}
              Ask Clerk
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Register-only answers — protected facts come verbatim from an
              approved claim, never from the model.
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="clerk-question" className="sr-only">
                Question
              </Label>
              <Textarea
                id="clerk-question"
                rows={2}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="e.g. What is the VAT rate?"
                data-testid="input-question"
              />
            </div>
            <Button
              onClick={handleAsk}
              disabled={ask.isPending || question.trim().length < 3}
              data-testid="button-ask"
            >
              {ask.isPending ? "Asking…" : "Ask Clerk"}
            </Button>
            {answer && <AnswerCard answer={answer} />}
          </CardContent>
        </Card>

        <Card data-testid="card-explain">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <BookOpen className="w-4 h-4 text-primary" aria-hidden="true" />{" "}
              Explain a rejection code
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Catalogue-grounded cause and fix (CLK-KB-05) — codes outside the
              catalogue are refused, not improvised.
            </p>
            <div className="flex items-end gap-2">
              <div className="flex-1 space-y-1.5">
                <Label htmlFor="clerk-error-code" className="sr-only">
                  Error code
                </Label>
                <Input
                  id="clerk-error-code"
                  value={errorCode}
                  onChange={(e) => setErrorCode(e.target.value)}
                  placeholder="MBS_…"
                  data-testid="input-error-code"
                />
              </div>
              <Button
                onClick={handleExplain}
                disabled={explain.isPending || !errorCode.trim()}
                data-testid="button-explain"
              >
                {explain.isPending ? "Looking up…" : "Explain"}
              </Button>
            </div>
            {explanation && <ExplanationCard explanation={explanation} />}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
