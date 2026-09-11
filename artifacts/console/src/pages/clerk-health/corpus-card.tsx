import { useState } from "react";
import {
  useListEvalFixtures,
  useMintFixtureFromCase,
  useRetireEvalFixture,
  useRestoreEvalFixture,
  getListEvalFixturesQueryKey,
} from "@workspace/api-client-react";
import type { EvalFixtureSummary } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { QueryError } from "@/components/query-error";
import { ScrollRegion } from "@/components/scroll-region";
import { useToast } from "@/hooks/use-toast";
import { userErrorMessage } from "@/lib/errors";
import { formatPct, pillClasses } from "@/lib/format";
import {
  EVAL_RISK_TONE,
  EVAL_OUTCOME_TONE,
  FIXTURE_SOURCE_TONE,
  fixtureSourceLabel,
  fixtureAccuracy,
  retireDisabledReason,
  corpusSummary,
  mintFixtureErrorCopy,
  CORPUS_PREVIEW_ROWS,
  visibleFixtureCount,
} from "./format";

// The evaluation corpus card of the Evals tab (R110: split out of the page).

export function EvalCorpusCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const {
    data: corpus,
    isLoading,
    error,
    refetch,
  } = useListEvalFixtures({
    query: { queryKey: getListEvalFixturesQueryKey(), retry: false },
  });
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListEvalFixturesQueryKey() });

  const [showAll, setShowAll] = useState(false);
  const [pendingRetire, setPendingRetire] = useState<EvalFixtureSummary | null>(
    null,
  );

  // Corpus promotion: a decided capture case becomes a grown fixture. The
  // scrub box starts checked and STAYS the operator's call in the UI — the
  // server is the enforcer (SCRUB_REQUIRED while the case's client is
  // active), and its refusal surfaces inline rather than being pre-empted by
  // a disabled control.
  const [mintCaseId, setMintCaseId] = useState("");
  const [mintScrub, setMintScrub] = useState(true);
  const [mintedKey, setMintedKey] = useState<string | null>(null);
  const [mintError, setMintError] = useState<string | null>(null);
  const mint = useMintFixtureFromCase({
    mutation: {
      onSuccess: (fx) => {
        invalidate();
        setMintedKey(fx.key);
        setMintError(null);
        setMintCaseId("");
      },
      onError: (e) => {
        setMintedKey(null);
        setMintError(mintFixtureErrorCopy(e));
      },
    },
  });
  const submitMint = () => {
    const caseId = mintCaseId.trim();
    if (!caseId || mint.isPending) return;
    setMintedKey(null);
    setMintError(null);
    mint.mutate({ data: { caseId, scrub: mintScrub } });
  };

  const retire = useRetireEvalFixture({
    mutation: {
      onSuccess: (fx) => {
        invalidate();
        setPendingRetire(null);
        toast({
          title: `Retired ${fx.key}`,
          description:
            "It is out of every future evaluation run and canary. Restore it here any time.",
        });
      },
      onError: (e) => {
        setPendingRetire(null);
        toast({
          title: "Could not retire the fixture",
          description: userErrorMessage(e) ?? "Try again in a moment.",
          variant: "destructive",
        });
      },
    },
  });
  const restore = useRestoreEvalFixture({
    mutation: {
      onSuccess: (fx) => {
        invalidate();
        toast({
          title: `Restored ${fx.key}`,
          description: "It rejoins the corpus from the next run onward.",
        });
      },
      onError: (e) =>
        toast({
          title: "Could not restore the fixture",
          description: userErrorMessage(e) ?? "Try again in a moment.",
          variant: "destructive",
        }),
    },
  });

  const fixtures = corpus?.fixtures ?? [];
  const shown = fixtures.slice(
    0,
    visibleFixtureCount(fixtures.length, showAll),
  );
  const rowBusy = (key: string) =>
    (retire.isPending && retire.variables?.key === key) ||
    (restore.isPending && restore.variables?.key === key);

  return (
    <Card data-testid="section-eval-corpus">
      <CardHeader>
        <CardTitle className="text-base">Evaluation corpus</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Every fixture the evaluation and canaries run over, with its pass
          history from stored runs. Retiring a grown or red-team fixture removes
          it from every future run and canary — static fixtures ship in code and
          stay read-only here.
        </p>
        {isLoading ? (
          <Skeleton className="h-24" />
        ) : error || !corpus ? (
          <QueryError
            thing="the evaluation corpus"
            onRetry={() => refetch()}
            detail={error instanceof Error ? error.message : undefined}
          />
        ) : fixtures.length === 0 ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="text-corpus-empty"
          >
            No fixtures in the corpus yet.
          </p>
        ) : (
          <>
            <p
              className="text-xs text-muted-foreground"
              data-testid="text-corpus-summary"
            >
              {corpusSummary(corpus)}
            </p>
            <ScrollRegion
              label="Evaluation corpus table"
              id="table-eval-corpus-region"
            >
              <table className="w-full text-sm" data-testid="table-eval-corpus">
                <thead>
                  <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Fixture</th>
                    <th className="py-2 pr-3 font-medium">Source</th>
                    <th className="py-2 pr-3 font-medium">Risk</th>
                    <th className="py-2 pr-3 font-medium text-right">Runs</th>
                    <th className="py-2 pr-3 font-medium">Last outcome</th>
                    <th className="py-2 pr-3 font-medium text-right">
                      Accuracy
                    </th>
                    <th className="py-2 font-medium text-right">Curation</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {shown.map((f) => {
                    const accuracy = fixtureAccuracy(f);
                    const staticReason = retireDisabledReason(f.source);
                    const busy = rowBusy(f.key);
                    return (
                      <tr
                        key={f.key}
                        className={f.retired ? "opacity-60" : ""}
                        data-testid={`row-corpus-${f.key}`}
                      >
                        <td className="py-2 pr-3">
                          <span className="block max-w-56 truncate">
                            {f.label}
                          </span>
                          <code className="text-xs text-muted-foreground">
                            {f.key}
                          </code>
                        </td>
                        <td className="py-2 pr-3">
                          <span
                            className={pillClasses(
                              FIXTURE_SOURCE_TONE[f.source] ?? "slate",
                            )}
                          >
                            {fixtureSourceLabel(f.source)}
                          </span>
                        </td>
                        <td className="py-2 pr-3">
                          <span
                            className={pillClasses(
                              EVAL_RISK_TONE[f.riskLabel] ?? "slate",
                            )}
                          >
                            {f.riskLabel}
                          </span>
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {f.runs ?? 0}
                        </td>
                        <td className="py-2 pr-3">
                          {f.lastOutcome ? (
                            <span
                              className={pillClasses(
                                EVAL_OUTCOME_TONE[f.lastOutcome] ?? "slate",
                              )}
                            >
                              {f.lastOutcome}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {accuracy == null ? "—" : formatPct(accuracy)}
                          {(f.injectionFixtures ?? 0) > 0 && (
                            <span className="block text-xs text-muted-foreground">
                              resisted {f.injectionResisted ?? 0}/
                              {f.injectionFixtures}
                            </span>
                          )}
                        </td>
                        <td className="py-2 text-right">
                          {f.retired ? (
                            <span className="inline-flex items-center gap-2">
                              <span className={pillClasses("slate")}>
                                retired
                              </span>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => restore.mutate({ key: f.key })}
                                disabled={busy}
                                data-testid={`button-restore-${f.key}`}
                              >
                                {busy ? "Restoring…" : "Restore"}
                              </Button>
                            </span>
                          ) : staticReason ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span
                                  className="text-xs text-muted-foreground cursor-help"
                                  tabIndex={0}
                                  data-testid={`text-static-${f.key}`}
                                >
                                  read-only
                                </span>
                              </TooltipTrigger>
                              <TooltipContent className="max-w-64">
                                {staticReason}
                              </TooltipContent>
                            </Tooltip>
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setPendingRetire(f)}
                              disabled={busy}
                              data-testid={`button-retire-${f.key}`}
                            >
                              {busy ? "Retiring…" : "Retire"}
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </ScrollRegion>
            {fixtures.length > CORPUS_PREVIEW_ROWS && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setShowAll((o) => !o)}
                aria-expanded={showAll}
                aria-controls="table-eval-corpus-region"
                data-testid="button-corpus-show-all"
              >
                {showAll
                  ? `Show first ${CORPUS_PREVIEW_ROWS}`
                  : `Show all ${fixtures.length} fixtures`}
              </Button>
            )}
          </>
        )}

        {/* Corpus promotion: the operator names a decided case; the server
            re-reads it, pseudonymizes known party identities in the document
            text (enforced while the client is active) and stores it as a
            grown fixture. */}
        <div
          className="space-y-2 border-t pt-3"
          data-testid="form-mint-fixture"
        >
          <p className="text-xs font-medium text-muted-foreground uppercase">
            Promote a case
          </p>
          <p className="text-xs text-muted-foreground">
            Turn a decided capture case into a grown fixture: its document text
            becomes part of every future evaluation run and canary.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={mintCaseId}
              onChange={(e) => {
                setMintCaseId(e.target.value);
                setMintedKey(null);
                setMintError(null);
              }}
              placeholder="Case id…"
              className="w-72 font-mono text-xs"
              aria-label="Case id to promote"
              data-testid="input-mint-case-id"
            />
            <Button
              size="sm"
              onClick={submitMint}
              disabled={mint.isPending || mintCaseId.trim().length === 0}
              data-testid="button-mint-fixture"
            >
              {mint.isPending ? "Minting…" : "Mint fixture"}
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Checkbox
              id="mint-scrub"
              checked={mintScrub}
              onCheckedChange={(v) => setMintScrub(v === true)}
              data-testid="checkbox-mint-scrub"
            />
            <Label htmlFor="mint-scrub" className="text-sm font-normal">
              Pseudonymize identities
            </Label>
            <span className="text-xs text-muted-foreground">
              required while the client is active
            </span>
          </div>
          {mintError && (
            <p
              className="text-xs text-destructive"
              data-testid="text-mint-error"
            >
              {mintError}
            </p>
          )}
          {mintedKey && (
            <p
              className="text-xs font-medium text-emerald-700 dark:text-emerald-400"
              data-testid="text-mint-success"
            >
              Minted fixture <code>{mintedKey}</code> — it joins every future
              run and canary.
            </p>
          )}
        </div>

        {/* Retiring is reversible but consequential — every future run and
            canary skips the fixture — so it takes an explicit confirm. */}
        <AlertDialog
          open={pendingRetire !== null}
          onOpenChange={(open) => {
            if (!open) setPendingRetire(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Retire {pendingRetire?.key}?</AlertDialogTitle>
              <AlertDialogDescription>
                Retiring this fixture removes it from every future run and
                canary. Its past run history is kept, and you can restore it
                from this table at any time.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel data-testid="button-cancel-retire">
                Keep it
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  if (pendingRetire) retire.mutate({ key: pendingRetire.key });
                }}
                data-testid="button-confirm-retire"
              >
                Retire fixture
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}

// Routed Health page inside the Clerk shell (the panel itself stays
// standalone so it can be embedded elsewhere if ever needed).
