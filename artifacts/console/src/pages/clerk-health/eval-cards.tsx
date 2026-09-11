import { useState } from "react";
import {
  useRunIntentEval,
  useListIntentEvalRuns,
  getListIntentEvalRunsQueryKey,
  useRunPhrasingEval,
  useListPhrasingEvalRuns,
  getListPhrasingEvalRunsQueryKey,
  useRunRetrievalEval,
  useListRetrievalEvalRuns,
  getListRetrievalEvalRunsQueryKey,
  useGetDigestImpact,
  getGetDigestImpactQueryKey,
  useListIntentFixtures,
  useMintIntentFixture,
  useRetireIntentFixture,
  useRestoreIntentFixture,
  getListIntentFixturesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { userErrorMessage } from "@/lib/errors";
import { formatDateTime, formatPct } from "@/lib/format";
import {
  retrievalRunLine,
  retrievalMissLine,
  retrievalTrendLine,
} from "./format";

// The evaluation cards of the Evals tab (R110: split out of the page): intent,
// digest-impact, phrasing and retrieval evals, and the promote-to-corpus
// control the Quality tab's feedback list uses.

export function IntentEvalCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: runs, isSuccess } = useListIntentEvalRuns({
    query: { queryKey: getListIntentEvalRunsQueryKey(), retry: false },
  });
  const { data: grownFixtures } = useListIntentFixtures({
    query: { queryKey: getListIntentFixturesQueryKey(), retry: false },
  });
  const invalidateFixtures = () =>
    queryClient.invalidateQueries({
      queryKey: getListIntentFixturesQueryKey(),
    });
  const retireFx = useRetireIntentFixture({
    mutation: { onSuccess: invalidateFixtures },
  });
  const restoreFx = useRestoreIntentFixture({
    mutation: { onSuccess: invalidateFixtures },
  });
  const runEval = useRunIntentEval({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: getListIntentEvalRunsQueryKey(),
        });
      },
      onError: () =>
        toast({ title: "Intent eval failed", variant: "destructive" }),
    },
  });
  if (!isSuccess) return null;
  const newest = runs?.[0];
  return (
    <Card data-testid="section-intent-eval">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Ask classifier evaluation</CardTitle>
        <Button
          size="sm"
          onClick={() => runEval.mutate({ data: {} })}
          disabled={runEval.isPending}
          data-testid="button-run-intent-eval"
        >
          {runEval.isPending ? "Running…" : "Run intent eval"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-xs text-muted-foreground">
          Replays a fixed corpus of questions against the live intent prompt
          (one classify call per fixture) and scores the classification
          deterministically — including two prompt-injection questions.
        </p>
        {grownFixtures && grownFixtures.length > 0 && (
          <div className="space-y-1" data-testid="grown-intent-list">
            <p
              className="text-xs font-medium text-muted-foreground uppercase"
              data-testid="text-grown-intent-count"
            >
              Grown corpus —{" "}
              {grownFixtures.filter((f) => f.retiredAt === null).length} active
              {grownFixtures.some((f) => f.retiredAt !== null)
                ? `, ${grownFixtures.filter((f) => f.retiredAt !== null).length} retired`
                : ""}{" "}
              (runs with the static fixtures)
            </p>
            {grownFixtures.slice(0, 8).map((f) => (
              <div
                key={f.id}
                className="flex items-center gap-2 text-xs"
                data-testid={`grown-fixture-${f.id}`}
              >
                <span
                  className={`min-w-0 flex-1 truncate ${f.retiredAt ? "text-muted-foreground line-through" : ""}`}
                >
                  {f.question}
                </span>
                <span className="font-mono text-muted-foreground">
                  {f.expected.claimKey}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-xs"
                  disabled={retireFx.isPending || restoreFx.isPending}
                  onClick={() =>
                    f.retiredAt
                      ? restoreFx.mutate({ id: f.id })
                      : retireFx.mutate({ id: f.id })
                  }
                  data-testid={`button-grown-toggle-${f.id}`}
                >
                  {f.retiredAt ? "Restore" : "Retire"}
                </Button>
              </div>
            ))}
          </div>
        )}
        {!newest ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="text-intent-eval-empty"
          >
            No intent eval runs yet — run one to baseline the classifier.
          </p>
        ) : (
          <div className="space-y-1" data-testid="intent-eval-latest">
            <p className="text-sm">
              Latest: {newest.correctCount}/{newest.fixtureCount} correct ·
              injection {newest.injectionResisted}/{newest.injectionFixtures}{" "}
              resisted · <code>{newest.promptVersion}</code> ·{" "}
              {formatDateTime(newest.createdAt)}
            </p>
            {newest.results.filter((r) => !r.correct).length > 0 && (
              <p className="text-xs text-muted-foreground">
                Missed:{" "}
                {newest.results
                  .filter((r) => !r.correct)
                  .map((r) => r.key)
                  .join(", ")}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Digest impact (round 20): the digest auditing itself — week-over-week
// movement of firms' urgent counts between consecutive fact snapshots,
// split by delivered vs not. Renders only once real pairs exist; the
// server's note pins correlation-not-causation.
export function DigestImpactCard() {
  const { data: report, isSuccess } = useGetDigestImpact({
    query: { queryKey: getGetDigestImpactQueryKey(), retry: false },
  });
  if (
    !isSuccess ||
    !report ||
    (report.delivered.pairs === 0 && report.undelivered.pairs === 0)
  ) {
    return null;
  }
  const bucket = (
    label: string,
    b: {
      pairs: number;
      meanUrgentDelta: number | null;
      improvedShare: number | null;
    },
    testId: string,
  ) => (
    <div className="rounded-md border p-3" data-testid={testId}>
      <p className="text-xs font-medium uppercase text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 text-sm tabular-nums">
        {b.pairs} week-pair{b.pairs === 1 ? "" : "s"}
        {b.improvedShare !== null && (
          <> · improved {formatPct(b.improvedShare)}</>
        )}
        {b.meanUrgentDelta !== null && (
          <>
            {" "}
            · urgent {b.meanUrgentDelta > 0 ? "+" : ""}
            {b.meanUrgentDelta.toFixed(1)}/wk
          </>
        )}
      </p>
    </div>
  );
  return (
    <Card data-testid="card-digest-impact">
      <CardHeader>
        <CardTitle className="text-base">Digest impact</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          {bucket("Digest delivered", report.delivered, "impact-delivered")}
          {bucket("Not delivered", report.undelivered, "impact-undelivered")}
        </div>
        <p className="text-xs text-muted-foreground">{report.note}</p>
      </CardContent>
    </Card>
  );
}

// Phrasing eval lane (rounds 18-19): the phrasing surfaces' regression
// card (digest, chaser, client statement, VAT note) — replay fixed
// synthetic fact packs through the live prompt builders
// and score grounding, required identifiers and forbidden content
// deterministically (including injection letters). Candidate-prompt canaries
// run through the API's candidateSystem field; this card shows the stored
// trend.
export function PhrasingEvalCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: runs, isSuccess } = useListPhrasingEvalRuns({
    query: { queryKey: getListPhrasingEvalRunsQueryKey(), retry: false },
  });
  const runEval = useRunPhrasingEval({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: getListPhrasingEvalRunsQueryKey(),
        });
      },
      onError: () =>
        toast({ title: "Phrasing eval failed", variant: "destructive" }),
    },
  });
  if (!isSuccess) return null;
  const newest = runs?.[0];
  return (
    <Card data-testid="section-phrasing-eval">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Phrasing evaluation</CardTitle>
        <Button
          size="sm"
          onClick={() => runEval.mutate({ data: {} })}
          disabled={runEval.isPending}
          data-testid="button-run-phrasing-eval"
        >
          {runEval.isPending ? "Running…" : "Run phrasing eval"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-xs text-muted-foreground">
          Replays fixed synthetic fact packs through every phrased
          surface&apos;s live prompts (one call per fixture) and scores the
          output deterministically: number grounding, required identifiers,
          forbidden content — including prompt-injection fixtures on every
          surface with an outsider-influenced fact slot.
        </p>
        {!newest ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="text-phrasing-eval-empty"
          >
            No phrasing eval runs yet — run one to baseline the prompts.
          </p>
        ) : (
          <div className="space-y-1" data-testid="phrasing-eval-latest">
            <p className="text-sm">
              Latest: {newest.correctCount}/{newest.fixtureCount} correct ·{" "}
              {newest.groundedCount}/{newest.fixtureCount} grounded · injection{" "}
              {newest.injectionResisted}/{newest.injectionFixtures} resisted ·{" "}
              {Object.entries(newest.promptVersions ?? {}).map(([k, v]) => (
                <code key={k} className="mr-1">
                  {v}
                </code>
              ))}
              · {formatDateTime(newest.createdAt)}
            </p>
            {newest.results.filter((r) => !r.correct).length > 0 && (
              <p className="text-xs text-muted-foreground">
                Failed:{" "}
                {newest.results
                  .filter((r) => !r.correct)
                  .map((r) => `${r.key} (${r.failures.join("; ")})`)
                  .join(", ")}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Retrieval eval card headless core (the R27 convention): pure line
// builders the vitest suite pins without rendering.

export function RetrievalEvalCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: runs, isSuccess } = useListRetrievalEvalRuns({
    query: { queryKey: getListRetrievalEvalRunsQueryKey(), retry: false },
  });
  const runEval = useRunRetrievalEval({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: getListRetrievalEvalRunsQueryKey(),
        });
      },
      onError: (e) =>
        toast({
          title: "Retrieval eval failed",
          description:
            userErrorMessage(e) ??
            "The embedding provider may not be configured.",
          variant: "destructive",
        }),
    },
  });
  if (!isSuccess) return null;
  const newest = runs?.[0];
  return (
    <Card data-testid="section-retrieval-eval">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Memory retrieval evaluation</CardTitle>
        <Button
          size="sm"
          onClick={() => runEval.mutate()}
          disabled={runEval.isPending}
          data-testid="button-run-retrieval-eval"
        >
          {runEval.isPending ? "Running…" : "Run retrieval eval"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-xs text-muted-foreground">
          Embeds a fixed labeled corpus with the live embedding model and scores
          whether each query ranks its right document first — recall@k and mean
          reciprocal rank, computed deterministically in app code. A drop means
          the embedding model changed or regressed; the firm-memory surfaces
          (semantic reply exemplars, Ask memory notes) inherit whatever this
          measures.
        </p>
        {!newest ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="text-retrieval-eval-empty"
          >
            No retrieval eval runs yet — run one to baseline the embedding
            model.
          </p>
        ) : (
          <div className="space-y-1" data-testid="retrieval-eval-latest">
            <p className="text-sm">
              Latest: {retrievalRunLine(newest)} · <code>{newest.model}</code> ·{" "}
              {formatDateTime(newest.createdAt)}
            </p>
            {retrievalMissLine(newest) && (
              <p className="text-xs text-muted-foreground">
                {retrievalMissLine(newest)}
              </p>
            )}
            {retrievalTrendLine(runs) && (
              <p className="text-xs text-muted-foreground">
                Trend: {retrievalTrendLine(runs)}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Promote a not-helpful question into the grown intent corpus (round 16).
// The operator supplies the key the classifier SHOULD have chosen; the
// server validates it against the eval's frozen offered context, scrubs the
// question onto the synthetic directory, and refuses anything it cannot
// represent — every failure carries the reason.
export function PromoteToIntentCorpus({ caseId }: { caseId: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [claimKey, setClaimKey] = useState("");
  const [month, setMonth] = useState("");
  const [client, setClient] = useState("");
  const mint = useMintIntentFixture({
    mutation: {
      onSuccess: (fixture) => {
        setOpen(false);
        setClaimKey("");
        setMonth("");
        setClient("");
        queryClient.invalidateQueries({
          queryKey: getListIntentFixturesQueryKey(),
        });
        // Surface the SCRUBBED text so the operator can immediately judge
        // (and retire) a mangled mint from the eval card's grown list.
        toast({
          title: "Added to the intent eval corpus",
          description: fixture.question,
        });
      },
      onError: (e) =>
        toast({
          title: "Could not promote the question",
          description:
            userErrorMessage(e) ??
            "The expected key must come from the eval's offered context.",
          variant: "destructive",
        }),
    },
  });
  if (!open) {
    return (
      <Button
        size="sm"
        variant="ghost"
        className="h-6 px-2 text-xs"
        onClick={() => setOpen(true)}
        data-testid={`button-promote-${caseId}`}
      >
        Promote to corpus
      </Button>
    );
  }
  return (
    <span className="flex items-center gap-1">
      <Input
        value={claimKey}
        onChange={(e) => setClaimKey(e.target.value)}
        placeholder="expected key, e.g. data.chase_list"
        className="h-6 w-48 text-xs"
        data-testid={`input-promote-key-${caseId}`}
      />
      <Input
        value={month}
        onChange={(e) => setMonth(e.target.value)}
        placeholder="month pin"
        className="h-6 w-24 text-xs"
        data-testid={`input-promote-month-${caseId}`}
      />
      <Input
        value={client}
        onChange={(e) => setClient(e.target.value)}
        placeholder="client pin"
        className="h-6 w-20 text-xs"
        data-testid={`input-promote-client-${caseId}`}
      />
      <Button
        size="sm"
        className="h-6 px-2 text-xs"
        disabled={mint.isPending || claimKey.trim().length === 0}
        onClick={() =>
          mint.mutate({
            data: {
              caseId,
              expected: {
                claimKey: claimKey.trim(),
                ...(month.trim() ? { month: month.trim() } : {}),
                ...(client.trim() ? { client: client.trim() } : {}),
              },
            },
          })
        }
        data-testid={`button-promote-confirm-${caseId}`}
      >
        {mint.isPending ? "Minting…" : "Mint"}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-6 px-2 text-xs"
        onClick={() => setOpen(false)}
      >
        Cancel
      </Button>
    </span>
  );
}
