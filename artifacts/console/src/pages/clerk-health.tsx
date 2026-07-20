import { useState, type ReactNode } from "react";
import {
  useGetClerkMetrics,
  useRunClerkEval,
  useListClerkEvalRuns,
  useListEvalFixtures,
  useRetireEvalFixture,
  useRestoreEvalFixture,
  useGetExtractionPrompt,
  useRunPromptCanary,
  useRunModelCanary,
  useGetClerkTierReport,
  getGetClerkMetricsQueryKey,
  getListClerkEvalRunsQueryKey,
  getListEvalFixturesQueryKey,
  getGetExtractionPromptQueryKey,
  getGetClerkTierReportQueryKey,
} from "@workspace/api-client-react";
import type {
  ClerkMetrics,
  ClerkMetricsCases,
  ClerkMetricsQualityAlert,
  EvalFixtureReport,
  EvalFixtureSummary,
  ModelCanaryReport,
  PromptCanaryReport,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { QueryError } from "@/components/query-error";
import { ClerkPageHeader } from "@/components/clerk-shell";
import { StatTile } from "@/components/stat-tile";
import { useToast } from "@/hooks/use-toast";
import { usePageTitle } from "@/hooks/use-page-title";
import { serverErrorMessage } from "@/lib/errors";
import {
  formatDateTime,
  formatPct,
  pillClasses,
  type BadgeTone,
} from "@/lib/format";
import { STATUS_TONE } from "@/pages/clerk-shared";

// ---- Health tab -----------------------------------------------------------
// Read-only operational metrics for the Clerk: case flow, ask refusals and
// inference quality per model+prompt cohort. Numbers come straight from
// /clerk/metrics; the window selector re-queries the server.

const HEALTH_WINDOWS = [7, 30, 90];

// The health page's many stacked sections, grouped for navigation. Grouping
// is presentation only — every section keeps its exact markup and testids —
// and the resistance/quality alert banners are hoisted ABOVE the tabs so a
// drop stays visible regardless of the active tab.
export const HEALTH_TABS = [
  { value: "overview", label: "Overview" },
  { value: "quality", label: "Quality" },
  { value: "economics", label: "Economics" },
  { value: "evals", label: "Evals" },
  { value: "canaries", label: "Canaries" },
] as const;

const OUTCOME_TONE: Record<string, BadgeTone> = {
  ok: "emerald",
  invalid_discarded: "amber",
  error: "red",
};

// Evaluation fixtures: riskLabel is the fixture's NATURE (what it tests),
// outcome is what the model did with it. Injection fixtures are violet — an
// adversarial fixture is not a failure; a followed injection is (red pill in
// the detail row).
const EVAL_RISK_TONE: Record<string, BadgeTone> = {
  clean: "slate",
  skewed: "amber",
  injection: "violet",
};

const EVAL_OUTCOME_TONE: Record<string, BadgeTone> = {
  ok: "emerald",
  invalid: "amber",
  error: "red",
};

// Eval runs take seconds to minutes (each fixture is a live model call), so
// switch to seconds above 1 s instead of reusing the ms-latency formatter.
export function fmtEvalDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  return `${Math.round(ms)} ms`;
}

// Token counts get grouping separators so 1234567 reads as 1,234,567.
export function fmtTokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return Math.round(n).toLocaleString();
}

// Estimated spend is usually cents per window, so allow up to 4 decimals.
// null means the server has no per-token rates configured for the models used.
export function fmtUsd(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return "—";
  return usd.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

// The Cases tile packs the flow timings into its detail line: decision
// turnaround plus its claim-based split into queue-wait and active-review
// (the split appears only once cases have claim timestamps).
export function casesTileDetail(cases: ClerkMetricsCases): string | undefined {
  const parts: string[] = [];
  if (cases.avgDecisionMinutes != null) {
    parts.push(`avg decision ${Math.round(cases.avgDecisionMinutes)} min`);
  }
  if (cases.avgQueueWaitMinutes != null) {
    parts.push(`queue wait ${Math.round(cases.avgQueueWaitMinutes)}m`);
  }
  if (cases.avgActiveReviewMinutes != null) {
    parts.push(`active review ${Math.round(cases.avgActiveReviewMinutes)}m`);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

// Override-rate cells go red above 25% (extraction quality needs prompt
// attention) and amber above 10% (worth a watchful eye).
export function overrideRateClass(rate: number): string {
  if (rate > 0.25) return "text-red-600 dark:text-red-400 font-medium";
  if (rate > 0.1) return "text-amber-700 dark:text-amber-400 font-medium";
  return "";
}

// A correction-shape example renders as "extracted → final"; a missing side
// (the operator filled a blank, or blanked a hallucination) shows the same
// em-dash sentinel the eval mismatch rows use.
export function shapeExample(
  extracted: string | null,
  final: string | null,
): string {
  return `${extracted ?? "—"} → ${final ?? "—"}`;
}

// Model-canary fixture rows: a regressed row (the candidate read the fixture
// worse than the incumbent) gets the red treatment; everything else stays
// plain.
export function modelCanaryRowClass(regressed: boolean): string {
  return regressed ? "bg-red-50 dark:bg-red-950/40" : "";
}

// The quality-watch banner sentence: a month-over-month drop in the share of
// extracted fields operators KEPT at approval. Phrased exactly like the
// resistance banner (rate, month, rate, month, sample size) so the two
// alerts read as one family.
export function qualityAlertText(alert: ClerkMetricsQualityAlert): string {
  return (
    `Extraction kept-rate dropped from ${formatPct(alert.fromRate)} ` +
    `(${alert.fromMonth}) to ${formatPct(alert.toRate)} (${alert.toMonth}) ` +
    `over ${alert.fields} fields — review recent corrections.`
  );
}

function BreakdownRow({
  title,
  entries,
  tones,
  testId,
}: {
  title: string;
  entries: Record<string, number>;
  tones: Record<string, BadgeTone>;
  testId: string;
}) {
  const items = Object.entries(entries).sort((a, b) => b[1] - a[1]);
  return (
    <div data-testid={testId}>
      <p className="text-xs font-medium text-muted-foreground uppercase mb-2">
        {title}
      </p>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing in this window.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {items.map(([key, count]) => (
            <span key={key} className={pillClasses(tones[key] ?? "slate")}>
              {key.replace(/_/g, " ")}
              <span className="tabular-nums font-semibold">{count}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// Prompt canary (round-5 idea #2): run the eval corpus under a CANDIDATE
// system prompt and the incumbent side by side. Decision support only — the
// verdict rule is deterministic and server-side, nothing is stored, and
// promotion is a code change the operator makes with this evidence in hand.
const VERDICT_TONE: Record<string, BadgeTone> = {
  improvement: "emerald",
  comparable: "slate",
  regression: "red",
};

// When the incumbent-prompt fetch fails, the prefill button cannot work —
// say WHY next to the permanently disabled control instead of leaving a dead
// button: the canary itself still runs fine on a hand-pasted candidate.
export function canaryPrefillNote(promptLoadFailed: boolean): string | null {
  return promptLoadFailed
    ? "Couldn't load the live prompt — paste a candidate manually."
    : null;
}

function PromptCanaryCard() {
  const { toast } = useToast();
  const { data: incumbent, isError: incumbentFailed } = useGetExtractionPrompt({
    query: { queryKey: getGetExtractionPromptQueryKey(), retry: false },
  });
  const prefillNote = canaryPrefillNote(incumbentFailed);
  const [candidate, setCandidate] = useState("");
  const [report, setReport] = useState<PromptCanaryReport | null>(null);
  const canary = useRunPromptCanary({
    mutation: {
      onSuccess: (res) => setReport(res),
      onError: (e) =>
        toast({
          title: "Canary failed",
          description: serverErrorMessage(e) ?? "Could not run the canary.",
          variant: "destructive",
        }),
    },
  });

  const side = (label: string, s: PromptCanaryReport["incumbent"]) => (
    <div className="rounded-md border p-3 space-y-1 text-sm" data-testid={`canary-${label}`}>
      <p className="text-xs font-medium text-muted-foreground uppercase">
        {label} · {s.promptVersion}
      </p>
      <p>
        Accuracy:{" "}
        <span className="font-semibold tabular-nums">
          {s.accuracy != null ? formatPct(s.accuracy) : "—"}
        </span>{" "}
        <span className="text-muted-foreground">
          ({s.fieldsCorrect}/{s.fieldsCompared} fields)
        </span>
      </p>
      <p>
        Injection resisted:{" "}
        <span className="font-semibold tabular-nums">
          {s.injectionResisted}/{s.injectionFixtures}
        </span>
        {s.failures > 0 && (
          <span className="text-muted-foreground"> · {s.failures} failed call(s)</span>
        )}
      </p>
    </div>
  );

  return (
    <Card data-testid="section-prompt-canary">
      <CardHeader>
        <CardTitle className="text-base">Prompt canary</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Test a candidate extraction prompt against the incumbent over the
          same eval corpus — twice the model calls of an evaluation run. The
          verdict is deterministic: injection resistance may never drop, and
          accuracy is judged outside a 2% noise band. Nothing is stored;
          promoting a prompt is a code change.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!incumbent}
            onClick={() => incumbent && setCandidate(incumbent.system)}
            data-testid="button-canary-prefill"
          >
            Start from the live prompt
          </Button>
          {prefillNote && (
            <p
              className="text-xs text-destructive"
              data-testid="text-canary-prefill-error"
            >
              {prefillNote}
            </p>
          )}
        </div>
        <Textarea
          value={candidate}
          onChange={(e) => {
            setCandidate(e.target.value);
            setReport(null);
          }}
          placeholder="Paste or edit the candidate system prompt (min 100 characters)…"
          className="min-h-[140px] font-mono text-xs"
          data-testid="input-canary-candidate"
        />
        <Button
          size="sm"
          disabled={canary.isPending || candidate.trim().length < 100}
          onClick={() =>
            canary.mutate({ data: { candidateSystem: candidate } })
          }
          data-testid="button-run-canary"
        >
          {canary.isPending ? "Running canary…" : "Run canary"}
        </Button>
        {report && (
          <div className="space-y-3" data-testid="canary-report">
            <div className="flex items-center gap-2">
              <span className={pillClasses(VERDICT_TONE[report.verdict] ?? "slate")}>
                {report.verdict}
              </span>
              <p className="text-sm">{report.verdictReason}</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {side("incumbent", report.incumbent)}
              {side("candidate", report.candidate)}
            </div>
            {report.fixtures.some((f) => f.regressed) && (
              <div className="text-xs text-muted-foreground">
                Regressed fixtures:{" "}
                {report.fixtures
                  .filter((f) => f.regressed)
                  .map((f) => f.label)
                  .join("; ")}
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              {report.fixtureCount} fixture(s)
              {report.truncated ? " (corpus truncated to the canary cap)" : ""} ·
              both sides ran the same corpus through the live gateway.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Model canary: the prompt canary's twin for models — run the eval corpus
// under a CANDIDATE model and the incumbent side by side. Decision support
// only — the verdict rule is deterministic and server-side, nothing is
// stored, and switching models is an env change (CLERK_MODEL_TIERS) the
// operator makes with this evidence in hand.
function ModelCanaryCard() {
  const { toast } = useToast();
  const [candidate, setCandidate] = useState("");
  const [report, setReport] = useState<ModelCanaryReport | null>(null);
  const canary = useRunModelCanary({
    mutation: {
      onSuccess: (res) => setReport(res),
      onError: (e) =>
        toast({
          title: "Model canary failed",
          description:
            serverErrorMessage(e) ?? "Could not run the model canary.",
          variant: "destructive",
        }),
    },
  });

  const side = (label: string, s: ModelCanaryReport["incumbent"]) => (
    <div
      className="rounded-md border p-3 space-y-1 text-sm"
      data-testid={`model-canary-${label}`}
    >
      <p className="text-xs font-medium text-muted-foreground uppercase">
        {label} · <span className="normal-case font-mono">{s.model}</span>
      </p>
      <p>
        Accuracy:{" "}
        <span className="font-semibold tabular-nums">
          {s.accuracy != null ? formatPct(s.accuracy) : "—"}
        </span>{" "}
        <span className="text-muted-foreground">
          ({s.fieldsCorrect}/{s.fieldsCompared} fields)
        </span>
      </p>
      <p>
        Injection resisted:{" "}
        <span className="font-semibold tabular-nums">
          {s.injectionResisted}/{s.injectionFixtures}
        </span>
        {s.failures > 0 && (
          <span className="text-muted-foreground"> · {s.failures} failed call(s)</span>
        )}
      </p>
    </div>
  );

  return (
    <Card data-testid="section-model-canary">
      <CardHeader>
        <CardTitle className="text-base">Model canary</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Test a candidate model against the incumbent over the same eval
          corpus — twice the model calls of an evaluation run. The verdict is
          deterministic: injection resistance may never drop, and accuracy is
          judged outside a 2% noise band. Nothing is stored; adopting a model
          is an env change (CLERK_MODEL_TIERS), canary first.
        </p>
        <Input
          value={candidate}
          onChange={(e) => {
            setCandidate(e.target.value);
            setReport(null);
          }}
          placeholder="Candidate model id…"
          maxLength={120}
          aria-label="Candidate model"
          data-testid="input-model-candidate"
        />
        <Button
          size="sm"
          disabled={canary.isPending || candidate.trim().length === 0}
          onClick={() =>
            canary.mutate({ data: { candidateModel: candidate.trim() } })
          }
          data-testid="button-run-model-canary"
        >
          {canary.isPending ? "Running canary…" : "Run canary"}
        </Button>
        {report && (
          <div className="space-y-3" data-testid="model-canary-report">
            <div className="flex items-center gap-2">
              <span className={pillClasses(VERDICT_TONE[report.verdict] ?? "slate")}>
                {report.verdict}
              </span>
              <p className="text-sm">{report.verdictReason}</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {side("incumbent", report.incumbent)}
              {side("candidate", report.candidate)}
            </div>
            <div className="overflow-x-auto">
              <table
                className="w-full text-sm"
                data-testid="table-model-canary-fixtures"
              >
                <thead>
                  <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Fixture</th>
                    <th className="py-2 pr-3 font-medium">Risk</th>
                    <th className="py-2 pr-3 font-medium text-right">
                      Incumbent
                    </th>
                    <th className="py-2 font-medium text-right">Candidate</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {report.fixtures.map((f) => (
                    <tr
                      key={f.key}
                      className={modelCanaryRowClass(f.regressed)}
                      data-testid={`row-model-fixture-${f.key}`}
                    >
                      <td className="py-2 pr-3">
                        {f.label}
                        {f.regressed && (
                          <span className="ml-2 text-[10px] font-medium uppercase text-red-600 dark:text-red-400">
                            regressed
                          </span>
                        )}
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
                        {f.incumbentCorrect}/{f.fieldsCompared}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {f.candidateCorrect}/{f.fieldsCompared}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground">
              {report.fixtureCount} fixture(s)
              {report.truncated ? " (corpus truncated to the canary cap)" : ""} ·
              both sides ran the same corpus through the live gateway.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---- Eval corpus curation --------------------------------------------------
// The full fixture inventory (static, grown, red-team) with per-fixture pass
// history reconstructed from stored runs. Curation is scoped on purpose:
// grown/red-team fixtures can be retired (and restored) from the UI; static
// fixtures ship in code, so their rows stay read-only with a tooltip saying
// why.

const FIXTURE_SOURCE_TONE: Record<string, BadgeTone> = {
  static: "slate",
  grown: "blue",
  redteam: "violet",
};

// "redteam" is the wire value; the chip reads "red-team" like the prose.
export function fixtureSourceLabel(source: string): string {
  return source === "redteam" ? "red-team" : source;
}

// Accuracy from history: correct/compared across every stored run that
// scored this fixture. Null (rendered as the em-dash sentinel) until a run
// has compared at least one field — 0/0 is "no history", not 0%.
export function fixtureAccuracy(f: {
  fieldsCompared?: number;
  fieldsCorrect?: number;
}): number | null {
  if (!f.fieldsCompared) return null;
  return (f.fieldsCorrect ?? 0) / f.fieldsCompared;
}

// Why a static row has no retire button. Null for grown/red-team rows, which
// are curatable.
export function retireDisabledReason(source: string): string | null {
  return source === "static"
    ? "Static fixtures ship in code — removing one is a code change, not a curation act."
    : null;
}

// One-line inventory summary so the card reads at a glance even collapsed.
export function corpusSummary(report: EvalFixtureReport): string {
  let staticCount = 0;
  let grown = 0;
  let redteam = 0;
  let retired = 0;
  for (const f of report.fixtures) {
    if (f.source === "static") staticCount += 1;
    else if (f.source === "grown") grown += 1;
    else if (f.source === "redteam") redteam += 1;
    if (f.retired) retired += 1;
  }
  const parts = [
    `${report.fixtures.length} fixture(s) — ${staticCount} static, ${grown} grown, ${redteam} red-team`,
  ];
  if (retired > 0) parts.push(`${retired} retired`);
  parts.push(`history from ${report.runsScanned} stored run(s)`);
  return parts.join(" · ");
}

// The corpus can run to 200+ rows (red-team growth); render a preview and
// let the operator expand to everything.
export const CORPUS_PREVIEW_ROWS = 25;
export function visibleFixtureCount(total: number, showAll: boolean): number {
  return showAll ? total : Math.min(total, CORPUS_PREVIEW_ROWS);
}

function EvalCorpusCard() {
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
          description: serverErrorMessage(e) ?? "Try again in a moment.",
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
          description: serverErrorMessage(e) ?? "Try again in a moment.",
          variant: "destructive",
        }),
    },
  });

  const fixtures = corpus?.fixtures ?? [];
  const shown = fixtures.slice(0, visibleFixtureCount(fixtures.length, showAll));
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
          history from stored runs. Retiring a grown or red-team fixture
          removes it from every future run and canary — static fixtures ship
          in code and stay read-only here.
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
            <p className="text-xs text-muted-foreground" data-testid="text-corpus-summary">
              {corpusSummary(corpus)}
            </p>
            <div className="overflow-x-auto" id="table-eval-corpus-region">
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
            </div>
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
              <AlertDialogTitle>
                Retire {pendingRetire?.key}?
              </AlertDialogTitle>
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
export function ClerkHealthPage() {
  usePageTitle("Clerk health");
  return (
    <div className="space-y-6">
      <ClerkPageHeader
        eyebrow="Operations"
        title="Health"
        description="Volume, accuracy, latency and cost for every Clerk surface — and the watchdog that trips the kill switch."
      />
      <HealthPanel />
    </div>
  );
}

export function HealthPanel() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [windowDays, setWindowDays] = useState(30);
  const params = { windowDays };
  const {
    data: metrics,
    isLoading,
    error,
    refetch,
  } = useGetClerkMetrics(params, {
    query: { queryKey: getGetClerkMetricsQueryKey(params) },
  });

  // Tier-suggestion report (round-9 idea #3): pure ledger SQL, so it loads
  // eagerly like the metrics — no model call, no cost to a page view.
  const { data: tierReport } = useGetClerkTierReport({
    query: {
      queryKey: getGetClerkTierReportQueryKey(),
      staleTime: 5 * 60_000,
      retry: false,
    },
  });

  // Evaluation runs: the synthetic fixture corpus scored against the live
  // model. Running one is a deliberate act (it spends real model calls), so
  // it sits behind a button rather than loading eagerly like the metrics.
  const evalParams = { limit: 20 };
  const {
    data: evalRuns,
    isLoading: evalRunsLoading,
    error: evalRunsError,
    refetch: refetchEvalRuns,
  } = useListClerkEvalRuns(evalParams, {
    query: { queryKey: getListClerkEvalRunsQueryKey(evalParams) },
  });

  const runEval = useRunClerkEval({
    mutation: {
      onSuccess: (run) => {
        queryClient.invalidateQueries({
          queryKey: getListClerkEvalRunsQueryKey(evalParams),
        });
        toast({
          title: "Evaluation complete",
          description: `Field accuracy ${formatPct(run.accuracy)} · injection resisted ${run.injectionResisted}/${run.injectionFixtures} across ${run.fixtureCount} fixtures.`,
        });
      },
      onError: (e) => {
        toast({
          title: "Evaluation failed",
          description:
            serverErrorMessage(e) ?? "Could not run the evaluation.",
          variant: "destructive",
        });
      },
    },
  });

  // Fixture-level detail for the most recent run, behind a toggle like the
  // capture form's open/close.
  const [showEvalDetail, setShowEvalDetail] = useState(false);
  const latestRun = evalRuns?.[0];

  // The metrics-driven tabs share one guard: skeleton while /clerk/metrics
  // loads, the query error (with its HTTP status) on failure, content once it
  // resolves. It repeats per tab because each tab owns its own subtree; the
  // callback parameter shadows `metrics` with the non-null value so the
  // section markup inside stays exactly as it was when stacked.
  const withMetrics = (
    render: (metrics: ClerkMetrics) => ReactNode,
  ): ReactNode =>
    isLoading ? (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
    ) : error || !metrics ? (
      <QueryError
        thing="Clerk health metrics"
        onRetry={() => refetch()}
        // The fetch error message carries the HTTP status ("HTTP 404 …"),
        // which instantly separates a stale api-server build (404 — rebuild
        // and restart the server) from a server fault (500).
        detail={error instanceof Error ? error.message : undefined}
      />
    ) : (
      render(metrics)
    );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-sm text-muted-foreground">
          How the Clerk is behaving — case flow, refusals and inference
          quality.
        </p>
        <div className="w-36">
          <Select
            value={String(windowDays)}
            onValueChange={(v) => setWindowDays(Number(v))}
          >
            <SelectTrigger
              aria-label="Metrics window"
              data-testid="select-health-window"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {HEALTH_WINDOWS.map((d) => (
                <SelectItem key={d} value={String(d)}>
                  Last {d} days
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Health-critical alerts are hoisted above the tabs so a
          resistance or kept-rate drop stays visible no matter which tab
          is active. Red stays reserved for guardrail alerts (the
          resistance drop); the kept-rate banner keeps its AMBER — a
          quality signal that deserves a watchful eye, matching the amber
          band of overrideRateClass. */}
      {metrics?.resistanceAlert && (
        <div
          className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
          data-testid="alert-resistance-drop"
        >
          <p className="font-semibold">
            Injection resistance dropped:{" "}
            {formatPct(metrics.resistanceAlert.fromRate)} in{" "}
            {metrics.resistanceAlert.fromMonth} →{" "}
            {formatPct(metrics.resistanceAlert.toRate)} in{" "}
            {metrics.resistanceAlert.toMonth} (
            {metrics.resistanceAlert.injectionFixtures} injection
            fixtures).
          </p>
          <p className="mt-1 text-xs">
            Review recent prompt changes and the red-team fixtures before
            promoting anything. The sweep has recorded this drop in the
            audit ledger.
          </p>
        </div>
      )}
      {metrics?.qualityAlert && (
        <div
          className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
          data-testid="alert-quality-drop"
        >
          <p className="font-semibold">
            {qualityAlertText(metrics.qualityAlert)}
          </p>
          <p className="mt-1 text-xs">
            Check the field-corrections and correction-shapes tables for
            where the overrides land before changing prompts or models.
          </p>
        </div>
      )}

      <Tabs defaultValue="overview">
        <TabsList className="h-auto flex-wrap" data-testid="tabs-health">
          {HEALTH_TABS.map((t) => (
            <TabsTrigger
              key={t.value}
              value={t.value}
              data-testid={`tab-health-${t.value}`}
            >
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {/* Every tab stays force-mounted (the advisory page's idiom) so
            section state — a run canary's report, the corpus "show all"
            toggle, the eval fixture detail — survives switching tabs,
            exactly as it did when the sections were stacked. */}
        <TabsContent
          value="overview"
          forceMount
          className="mt-4 space-y-4 data-[state=inactive]:hidden"
        >
          {withMetrics((metrics) => (
            <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label="Cases"
              value={String(metrics.cases.total)}
              detail={casesTileDetail(metrics.cases)}
              testId="stat-cases-total"
            />
            <StatTile
              label="Ask refusal rate"
              value={formatPct(metrics.ask.refusalRate)}
              detail={`${metrics.ask.refused} of ${metrics.ask.total} questions refused`}
              testId="stat-refusal-rate"
            />
            <StatTile
              label="Invalid inference rate"
              value={formatPct(metrics.inference.invalidRate)}
              detail={`error rate ${formatPct(metrics.inference.errorRate)} of ${metrics.inference.total} calls`}
              testId="stat-invalid-rate"
            />
            <StatTile
              label="Latency p95"
              value={fmtMs(metrics.inference.latencyP95Ms)}
              detail={`p50 ${fmtMs(metrics.inference.latencyP50Ms)}`}
              testId="stat-latency-p95"
            />
          </div>

          <div data-testid="section-cost">
            <p className="text-xs font-medium text-muted-foreground uppercase mb-2">
              Cost
            </p>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              <StatTile
                label="Prompt tokens"
                value={fmtTokens(metrics.cost.promptTokens)}
                testId="stat-cost-prompt-tokens"
              />
              <StatTile
                label="Completion tokens"
                value={fmtTokens(metrics.cost.completionTokens)}
                testId="stat-cost-completion-tokens"
              />
              <StatTile
                label="Calls with usage"
                value={fmtTokens(metrics.cost.callsWithUsage)}
                testId="stat-cost-calls-with-usage"
              />
              <StatTile
                label="Tokens / decided case"
                value={fmtTokens(metrics.cost.tokensPerDecidedCase)}
                testId="stat-cost-tokens-per-case"
              />
              <StatTile
                label="Estimated spend"
                value={fmtUsd(metrics.cost.estimatedUsd)}
                detail={
                  metrics.cost.estimatedUsd == null
                    ? "rates not configured"
                    : undefined
                }
                testId="stat-cost-estimated-usd"
              />
            </div>
          </div>

          <Card>
            <CardContent className="pt-6 space-y-4">
              <BreakdownRow
                title="Cases by status"
                entries={metrics.cases.byStatus}
                tones={STATUS_TONE}
                testId="breakdown-by-status"
              />
              <BreakdownRow
                title="Inference by outcome"
                entries={metrics.inference.byOutcome}
                tones={OUTCOME_TONE}
                testId="breakdown-by-outcome"
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Inference cohorts (model × prompt)
              </CardTitle>
            </CardHeader>
            <CardContent>
              {metrics.inference.cohorts.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No inference calls in this window.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                        <th className="py-2 pr-3 font-medium">Model</th>
                        <th className="py-2 pr-3 font-medium">Prompt</th>
                        <th className="py-2 pr-3 font-medium">Purpose</th>
                        <th className="py-2 pr-3 font-medium text-right">
                          Total
                        </th>
                        <th className="py-2 pr-3 font-medium text-right">OK</th>
                        <th className="py-2 font-medium text-right">p95</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {metrics.inference.cohorts.map((c) => (
                        <tr
                          key={`${c.model}-${c.promptVersion}-${c.purpose}`}
                          data-testid={`row-cohort-${c.model}-${c.promptVersion}-${c.purpose}`}
                        >
                          <td className="py-2 pr-3">
                            <code className="text-xs">{c.model}</code>
                          </td>
                          <td className="py-2 pr-3">
                            <code className="text-xs">{c.promptVersion}</code>
                          </td>
                          <td className="py-2 pr-3">{c.purpose}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {c.total}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {c.okCount}
                          </td>
                          <td className="py-2 text-right tabular-nums">
                            {fmtMs(c.latencyP95Ms)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
            </>
          ))}
        </TabsContent>

        <TabsContent
          value="quality"
          forceMount
          className="mt-4 space-y-4 data-[state=inactive]:hidden"
        >
          {withMetrics((metrics) => (
            <>
          {metrics.calibration && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  Confidence calibration
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  For approved cases, how often operators KEPT the model's
                  value at each confidence band ({metrics.calibration.sampleFields}{" "}
                  compared fields). Well-calibrated extraction keeps the two
                  columns close; a band where kept-rate falls far below the
                  confidence says the review-flagging threshold is trusting
                  numbers it shouldn't.
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm" data-testid="table-calibration">
                    <thead>
                      <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                        <th className="py-2 pr-3 font-medium">Confidence band</th>
                        <th className="py-2 pr-3 font-medium text-right">Fields</th>
                        <th className="py-2 pr-3 font-medium text-right">
                          Mean confidence
                        </th>
                        <th className="py-2 font-medium text-right">Kept rate</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {metrics.calibration.buckets.map((b) => (
                        <tr key={b.range} data-testid={`row-calibration-${b.range}`}>
                          <td className="py-2 pr-3">
                            <code className="text-xs">{b.range}</code>
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {b.fields}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {b.fields === 0 ? "—" : `${Math.round(b.meanConfidence * 100)}%`}
                          </td>
                          <td
                            className={`py-2 text-right tabular-nums ${
                              b.fields > 0 &&
                              b.meanConfidence - b.keptRate > 0.15
                                ? "text-red-600 dark:text-red-400 font-medium"
                                : ""
                            }`}
                          >
                            {b.fields === 0 ? "—" : `${Math.round(b.keptRate * 100)}%`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Field corrections</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">
                How often operators corrected each extracted field before
                approval — the extraction-quality signal (labeled outcomes).
              </p>
              {metrics.corrections.length === 0 ? (
                <p
                  className="text-sm text-muted-foreground"
                  data-testid="text-corrections-empty"
                >
                  No corrections yet — they appear once cases are approved.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table
                    className="w-full text-sm"
                    data-testid="table-corrections"
                  >
                    <thead>
                      <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                        <th className="py-2 pr-3 font-medium">Field</th>
                        <th className="py-2 pr-3 font-medium text-right">
                          Total
                        </th>
                        <th className="py-2 pr-3 font-medium text-right">
                          Overridden
                        </th>
                        <th className="py-2 font-medium text-right">
                          Override rate
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {metrics.corrections.map((c) => (
                        <tr
                          key={c.field}
                          data-testid={`row-correction-${c.field}`}
                        >
                          <td className="py-2 pr-3">
                            <code className="text-xs">{c.field}</code>
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {c.total}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {c.overridden}
                          </td>
                          <td
                            className={`py-2 text-right tabular-nums ${overrideRateClass(c.overrideRate)}`}
                          >
                            {formatPct(c.overrideRate)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {metrics.correctionShapes && metrics.correctionShapes.length > 0 && (
            <Card data-testid="section-correction-shapes">
              <CardHeader>
                <CardTitle className="text-base">Correction shapes</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  What KIND of mistake each override was — recurring
                  correction patterns from the same exhaust, with an example
                  of the change operators made.
                </p>
                <div className="overflow-x-auto">
                  <table
                    className="w-full text-sm"
                    data-testid="table-correction-shapes"
                  >
                    <thead>
                      <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                        <th className="py-2 pr-3 font-medium">Field</th>
                        <th className="py-2 pr-3 font-medium">Shape</th>
                        <th className="py-2 pr-3 font-medium text-right">
                          Count
                        </th>
                        <th className="py-2 font-medium">Example</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {metrics.correctionShapes.map((s) => (
                        <tr
                          key={`${s.field}-${s.shape}`}
                          data-testid={`row-correction-shape-${s.field}-${s.shape}`}
                        >
                          <td className="py-2 pr-3">
                            <code className="text-xs">{s.field}</code>
                          </td>
                          <td className="py-2 pr-3">
                            {s.shape.replace(/_/g, " ")}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {s.count}
                          </td>
                          <td className="py-2 text-xs text-muted-foreground">
                            {shapeExample(s.exampleExtracted, s.exampleFinal)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}

          <Card data-testid="section-supplier-accuracy">
            <CardHeader>
              <CardTitle className="text-base">Supplier accuracy</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Whose documents Clerk reads worst — override rates from the
                corrections exhaust, grouped by the approved invoice&apos;s
                register supplier. The list of clients worth nudging toward
                cleaner invoices.
              </p>
              {metrics.supplierAccuracy.length === 0 ? (
                <p
                  className="text-sm text-muted-foreground"
                  data-testid="text-supplier-accuracy-empty"
                >
                  No corrected approvals in this window yet.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table
                    className="w-full text-sm"
                    data-testid="table-supplier-accuracy"
                  >
                    <thead>
                      <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                        <th className="py-2 pr-3 font-medium">Supplier</th>
                        <th className="py-2 pr-3 font-medium">Firm</th>
                        <th className="py-2 pr-3 font-medium text-right">
                          Cases
                        </th>
                        <th className="py-2 pr-3 font-medium text-right">
                          Fields
                        </th>
                        <th className="py-2 pr-3 font-medium text-right">
                          Overridden
                        </th>
                        <th className="py-2 font-medium text-right">
                          Override rate
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {metrics.supplierAccuracy.map((s, i) => (
                        <tr key={i} data-testid={`row-supplier-accuracy-${i}`}>
                          <td className="py-2 pr-3">{s.supplierName}</td>
                          <td className="py-2 pr-3 text-muted-foreground">
                            {s.firmName ?? "—"}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {s.cases}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {s.fieldsCompared}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {s.overridden}
                          </td>
                          <td
                            className={`py-2 text-right tabular-nums ${overrideRateClass(s.overrideRate)}`}
                          >
                            {formatPct(s.overrideRate)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

              {(metrics.keptRateTrend?.length ?? 0) > 0 && (
        <Card data-testid="section-kept-rate-trend">
          <CardHeader>
            <CardTitle className="text-base">
              Extraction kept-rate trend
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              From the corrections exhaust — the share of compared fields
              operators KEPT unchanged when approving, by month. Pure SQL, no
              model involved in the judgment.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="table-kept-rate-months">
                <thead>
                  <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Month</th>
                    <th className="py-2 pr-3 font-medium text-right">Fields</th>
                    <th className="py-2 font-medium text-right">Kept rate</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {(metrics.keptRateTrend ?? []).map((m) => (
                    <tr key={m.month}>
                      <td className="py-2 pr-3 tabular-nums">{m.month}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {m.fields}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {m.fields === 0 ? "—" : formatPct(m.keptRate)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
              )}
            </>
          ))}
        </TabsContent>

        <TabsContent
          value="economics"
          forceMount
          className="mt-4 space-y-4 data-[state=inactive]:hidden"
        >
          {withMetrics((metrics) => (
            <>
          <Card data-testid="section-unit-economics">
            <CardHeader>
              <CardTitle className="text-base">
                Unit economics — where the tokens go
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              {metrics.economics.byPurpose.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No inference calls in this window.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                        <th className="py-2 pr-3 font-medium">Purpose</th>
                        <th className="py-2 pr-3 font-medium text-right">
                          Calls
                        </th>
                        <th className="py-2 pr-3 font-medium text-right">
                          Prompt tk
                        </th>
                        <th className="py-2 pr-3 font-medium text-right">
                          Completion tk
                        </th>
                        <th className="py-2 pr-3 font-medium text-right">
                          Errors
                        </th>
                        <th className="py-2 font-medium text-right">Est. spend</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {metrics.economics.byPurpose.map((p) => (
                        <tr
                          key={p.purpose}
                          data-testid={`row-economics-${p.purpose}`}
                        >
                          <td className="py-2 pr-3">{p.purpose}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {p.calls}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {fmtTokens(p.promptTokens)}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {fmtTokens(p.completionTokens)}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {p.errorCount}
                          </td>
                          <td className="py-2 text-right tabular-nums">
                            {fmtUsd(p.estimatedUsd)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div data-testid="economics-months">
                <p className="text-xs font-medium text-muted-foreground uppercase mb-2">
                  Failure taxonomy by month
                </p>
                {metrics.economics.months.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No inference history yet.
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                          <th className="py-2 pr-3 font-medium">Month</th>
                          <th className="py-2 pr-3 font-medium text-right">
                            Calls
                          </th>
                          <th className="py-2 pr-3 font-medium text-right">OK</th>
                          <th className="py-2 pr-3 font-medium text-right">
                            Invalid
                          </th>
                          <th className="py-2 pr-3 font-medium text-right">
                            Killed
                          </th>
                          <th className="py-2 font-medium text-right">Error</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {metrics.economics.months.map((m) => (
                          <tr key={m.month} data-testid={`row-economics-month-${m.month}`}>
                            <td className="py-2 pr-3 tabular-nums">{m.month}</td>
                            <td className="py-2 pr-3 text-right tabular-nums">
                              {m.calls}
                            </td>
                            <td className="py-2 pr-3 text-right tabular-nums">
                              {m.okCount}
                            </td>
                            <td className="py-2 pr-3 text-right tabular-nums">
                              {m.invalidCount}
                            </td>
                            <td className="py-2 pr-3 text-right tabular-nums">
                              {m.killedCount}
                            </td>
                            <td className="py-2 text-right tabular-nums">
                              {m.errorCount}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

        <Card data-testid="section-platform-spend">
          <CardHeader>
            <CardTitle className="text-base">
              Platform spend — {metrics.platformSpend.month}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <StatTile
                label="Tokens month-to-date"
                value={metrics.platformSpend.totalTokens.toLocaleString()}
                testId="stat-spend-total"
              />
              <StatTile
                label="Projected this month"
                value={metrics.platformSpend.projectedTokens.toLocaleString()}
                testId="stat-spend-projected"
              />
              <StatTile
                label="Est. cost"
                value={
                  metrics.platformSpend.estimatedUsd != null
                    ? `$${metrics.platformSpend.estimatedUsd.toFixed(2)}`
                    : "—"
                }
                testId="stat-spend-usd"
              />
              <StatTile
                label="Projected cost"
                value={
                  metrics.platformSpend.projectedUsd != null
                    ? `$${metrics.platformSpend.projectedUsd.toFixed(2)}`
                    : "—"
                }
                testId="stat-spend-projected-usd"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {metrics.platformSpend.firmFundedTokens.toLocaleString()} tokens
              firm-funded ·{" "}
              {metrics.platformSpend.platformFundedTokens.toLocaleString()}{" "}
              platform-funded (desk tooling, evals). Ledger totals on the same
              UTC month boundary the per-firm budgets use; cost estimates need
              CLERK_COST_PER_1M_INPUT_USD / _OUTPUT_USD set.
            </p>
          </CardContent>
        </Card>
            </>
          ))}

      {tierReport && tierReport.rows.length > 0 && (
        <Card data-testid="section-tier-report">
          <CardHeader>
            <CardTitle className="text-base">Model-tier evidence</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Trailing {tierReport.windowDays} days from the inference ledger,
              joined with the tier map in force (base model{" "}
              <span className="font-mono">{tierReport.baseModel}</span>).
              Recommendations are deterministic; act on them via
              CLERK_MODEL_TIERS (takes effect on server restart) and validate
              with a prompt canary first.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="table-tier-report">
                <thead>
                  <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Purpose</th>
                    <th className="py-2 pr-3 font-medium text-right">Calls</th>
                    <th className="py-2 pr-3 font-medium text-right">Tokens</th>
                    <th className="py-2 pr-3 font-medium text-right">Share</th>
                    <th className="py-2 pr-3 font-medium text-right">Valid</th>
                    <th className="py-2 pr-3 font-medium">Model</th>
                    <th className="py-2 font-medium">Recommendation</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {tierReport.rows.map((r) => (
                    <tr key={r.purpose}>
                      <td className="py-2 pr-3 font-mono text-xs">{r.purpose}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {r.calls}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {r.totalTokens.toLocaleString()}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {formatPct(r.spendShare)}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {formatPct(r.validRate)}
                      </td>
                      <td className="py-2 pr-3 font-mono text-xs">
                        {r.currentModel}
                        {r.tiered ? " (tier)" : ""}
                      </td>
                      <td className="py-2" title={r.reason}>
                        <span
                          className={pillClasses(
                            r.recommendation === "candidate"
                              ? "emerald"
                              : r.recommendation === "tiered"
                                ? "blue"
                                : r.recommendation === "revert"
                                  ? "red"
                                  : "slate",
                          )}
                        >
                          {r.recommendation.replace("_", " ")}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
        </TabsContent>

        <TabsContent
          value="evals"
          forceMount
          className="mt-4 space-y-4 data-[state=inactive]:hidden"
        >
      <Card data-testid="section-evaluation">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Evaluation</CardTitle>
          <Button
            size="sm"
            onClick={() => runEval.mutate()}
            disabled={runEval.isPending}
            data-testid="button-run-eval"
          >
            {runEval.isPending ? "Running…" : "Run evaluation"}
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Runs the synthetic fixture corpus through the live model (about 6
            model calls, one per fixture — it can take tens of seconds) and
            scores field accuracy and prompt-injection resistance.
          </p>
          {evalRunsLoading ? (
            <Skeleton className="h-24" />
          ) : evalRunsError ? (
            <QueryError
              thing="evaluation runs"
              onRetry={() => refetchEvalRuns()}
              detail={serverErrorMessage(evalRunsError)}
            />
          ) : !evalRuns || evalRuns.length === 0 ? (
            <p
              className="text-sm text-muted-foreground"
              data-testid="text-eval-empty"
            >
              No evaluation runs yet — run one to baseline the current model
              and prompt.
            </p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="table-eval-runs">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                      <th className="py-2 pr-3 font-medium">When</th>
                      <th className="py-2 pr-3 font-medium">Model</th>
                      <th className="py-2 pr-3 font-medium">Prompt</th>
                      <th className="py-2 pr-3 font-medium text-right">
                        Field accuracy
                      </th>
                      <th className="py-2 pr-3 font-medium text-right">
                        Injection
                      </th>
                      <th className="py-2 pr-3 font-medium text-right">
                        Fixtures
                      </th>
                      <th className="py-2 font-medium text-right">Duration</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {evalRuns.map((r) => (
                      <tr key={r.id} data-testid={`row-eval-run-${r.id}`}>
                        <td className="py-2 pr-3 whitespace-nowrap">
                          {formatDateTime(r.createdAt)}
                        </td>
                        <td className="py-2 pr-3">
                          <code className="text-xs">{r.model}</code>
                        </td>
                        <td className="py-2 pr-3">
                          <code className="text-xs">{r.promptVersion}</code>
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {formatPct(r.accuracy)}
                        </td>
                        <td
                          className={`py-2 pr-3 text-right tabular-nums ${
                            r.injectionResisted < r.injectionFixtures
                              ? "text-red-600 dark:text-red-400 font-medium"
                              : ""
                          }`}
                        >
                          {r.injectionResisted}/{r.injectionFixtures}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {r.fixtureCount}
                        </td>
                        <td className="py-2 text-right tabular-nums">
                          {fmtEvalDuration(r.durationMs)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {latestRun && (
                <div className="space-y-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setShowEvalDetail((o) => !o)}
                    aria-expanded={showEvalDetail}
                    aria-controls="detail-eval-fixtures"
                    data-testid="button-toggle-eval-detail"
                  >
                    {showEvalDetail
                      ? "Hide fixture detail"
                      : "Show fixture detail"}
                  </Button>
                  {showEvalDetail && (
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-muted-foreground uppercase">
                        Fixtures — most recent run
                      </p>
                      <div
                        className="border rounded-md divide-y text-sm"
                        id="detail-eval-fixtures"
                        data-testid="detail-eval-fixtures"
                      >
                        {latestRun.results.map((fx) => (
                          <div
                            key={fx.key}
                            className="px-3 py-2 space-y-1"
                            data-testid={`row-eval-fixture-${fx.key}`}
                          >
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="flex-1 min-w-0 truncate font-medium">
                                {fx.label}
                              </span>
                              <span
                                className={pillClasses(
                                  EVAL_RISK_TONE[fx.riskLabel] ?? "slate",
                                )}
                              >
                                {fx.riskLabel}
                              </span>
                              <span
                                className={pillClasses(
                                  EVAL_OUTCOME_TONE[fx.outcome] ?? "slate",
                                )}
                              >
                                {fx.outcome}
                              </span>
                              <span className="text-xs text-muted-foreground tabular-nums">
                                {fx.fieldsCorrect}/{fx.fieldsCompared} fields
                              </span>
                              {fx.injectionResisted === false && (
                                <span className={pillClasses("red")}>
                                  injection followed
                                </span>
                              )}
                            </div>
                            {fx.mismatches.length > 0 && (
                              <ul className="text-xs text-muted-foreground space-y-0.5">
                                {fx.mismatches.map((m) => (
                                  <li key={m.field}>
                                    <code>{m.field}</code>: {m.expected ?? "—"}{" "}
                                    → {m.actual ?? "—"}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

          <EvalCorpusCard />

      {metrics && metrics.injectionTrend.months.length > 0 && (
        <Card data-testid="section-injection-trend">
          <CardHeader>
            <CardTitle className="text-base">
              Injection resistance trend
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              From the stored evaluation runs (including red-team fixtures) —
              resistance is the share of injection fixtures where every
              critical field kept its legitimate value. Pure SQL, no model
              involved in the judgment.
            </p>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="table-injection-months">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                      <th className="py-2 pr-3 font-medium">Month</th>
                      <th className="py-2 pr-3 font-medium text-right">Runs</th>
                      <th className="py-2 font-medium text-right">Resisted</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {metrics.injectionTrend.months.map((m) => (
                      <tr key={m.month}>
                        <td className="py-2 pr-3 tabular-nums">{m.month}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {m.runs}
                        </td>
                        <td className="py-2 text-right tabular-nums">
                          {m.injectionFixtures === 0
                            ? "—"
                            : `${m.injectionResisted}/${m.injectionFixtures} (${formatPct(m.resistanceRate)})`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="table-injection-prompts">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                      <th className="py-2 pr-3 font-medium">Prompt</th>
                      <th className="py-2 pr-3 font-medium text-right">Runs</th>
                      <th className="py-2 font-medium text-right">Resisted</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {metrics.injectionTrend.byPromptVersion.map((p) => (
                      <tr key={p.promptVersion}>
                        <td className="py-2 pr-3 font-mono text-xs">
                          {p.promptVersion}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {p.runs}
                        </td>
                        <td className="py-2 text-right tabular-nums">
                          {p.injectionFixtures === 0
                            ? "—"
                            : `${p.injectionResisted}/${p.injectionFixtures} (${formatPct(p.resistanceRate)})`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
        </TabsContent>

        <TabsContent
          value="canaries"
          forceMount
          className="mt-4 space-y-4 data-[state=inactive]:hidden"
        >
          <PromptCanaryCard />
          <ModelCanaryCard />
        </TabsContent>
      </Tabs>
    </div>
  );
}
