import { useEffect, useMemo, useRef, useState } from "react";
import {
  useListClerkCases,
  useGetClerkCase,
  useCreateClerkCase,
  useDecideClerkCase,
  useClaimClerkCase,
  useReleaseClerkCase,
  useRetryClerkCase,
  useAskClerk,
  useGetClerkMetrics,
  useGetClerkPartySuggestions,
  useRunClerkEval,
  useListClerkEvalRuns,
  useListFirms,
  useListParties,
  getListClerkCasesQueryKey,
  getGetClerkCaseQueryKey,
  getGetClerkMetricsQueryKey,
  getGetClerkPartySuggestionsQueryKey,
  getListClerkEvalRunsQueryKey,
} from "@workspace/api-client-react";
import type {
  ClerkCase,
  ClerkCaseCreateInput,
  ClerkAnswer,
  ClerkCaseDecisionInputCategory,
  ClerkMetricsCases,
  ClerkPartySuggestion,
  InvoiceLineInput,
  ListClerkCasesParams,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { QueryError } from "@/components/query-error";
import { useToast } from "@/hooks/use-toast";
import { usePageTitle } from "@/hooks/use-page-title";
import { errorStatus } from "@/lib/errors";
import { formatDateTime, pillClasses, type BadgeTone } from "@/lib/format";
import {
  Activity,
  AlertTriangle,
  Bot,
  FileUp,
  MessageCircleQuestion,
  Mic,
  Plus,
  PowerOff,
  ShieldCheck,
} from "lucide-react";

// Clerk v0 is a shadow copilot for operators only. It reads documents and
// answers register questions, but it NEVER submits anything: an approval here
// creates a DRAFT invoice that still walks the normal human submission path.
// If the clerk_ai kill switch is off, the server answers 503 and this page
// says so instead of pretending.

const STATUS_TONE: Record<string, BadgeTone> = {
  pending: "slate",
  extracted: "blue",
  in_review: "amber",
  approved: "emerald",
  rejected: "red",
  escalated: "amber",
  failed: "red",
};

const CATEGORIES: ClerkCaseDecisionInputCategory[] = ["b2b", "b2g", "b2c"];

// The case queue loads in pages: with limit/offset present the server
// returns a bounded, newest-first slice instead of the full legacy list. A
// full page means there may be more — "Load more" appends the next one.
const PAGE_SIZE = 50;

function killSwitchTripped(err: unknown): boolean {
  return errorStatus(err) === 503;
}

function fieldValue(kase: ClerkCase, field: string): string {
  return (
    kase.extraction?.fields.find((f) => f.field === field)?.value ?? ""
  );
}

// The generated client's ApiError carries the parsed JSON error body on
// `data`; server errors are `{ error: string }`. Used to relay the server's
// own words (409 CASE_CLAIMED / CASE_CLAIM_CONFLICT, 422 VOICE_*).
function serverErrorMessage(err: unknown): string | undefined {
  const data = (err as { data?: { error?: unknown } } | null)?.data;
  return typeof data?.error === "string" ? data.error : undefined;
}

// Read a File into plain base64. Bytes are encoded directly (chunked to stay
// under the argument limit), so no data: URL prefix is ever produced — the
// backend strips one anyway.
async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// The server caps voice uploads at 5 MB; reject oversized files before
// wasting time base64-encoding them.
const MAX_VOICE_BYTES = 5 * 1024 * 1024;

// In-browser recordings auto-stop at 120 s — comfortably covers the
// ~90-second voice-note demo and keeps the blob far under the 5 MB cap.
const MAX_RECORD_SECONDS = 120;

// Coarse "n min ago" for claim ages — precision doesn't matter here.
function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.max(0, Math.round((Date.now() - then) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

// Operator ids are opaque — show enough to tell operators apart.
function shortActor(id: string | null | undefined): string {
  if (!id) return "unknown";
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

interface ApproveForm {
  firmId: string;
  supplierPartyId: string;
  buyerPartyId: string;
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  currency: string;
  category: ClerkCaseDecisionInputCategory;
  lines: InvoiceLineInput[];
}

// The API takes VAT rates as FRACTIONS ("0.075" = 7.5%) and rejects
// percent-style values loudly. The operator edits a percent in this form, so
// we normalise the extracted value to percent for display and convert back to
// a fraction on submit. If extraction found no usable VAT rate we leave the
// field EMPTY — never invent a default tax rate; the operator must enter one
// deliberately before approval is allowed.
function vatPercentFromRaw(raw: string | null): string {
  if (!raw) return "";
  const trimmed = String(raw).trim();
  const n = Number(trimmed.replace("%", "").trim());
  if (!Number.isFinite(n) || n < 0) return "";
  if (trimmed.includes("%")) return String(n);
  // Round away float artifacts (0.07 * 100 → 7.000000000000001).
  return String(n <= 1 ? Number((n * 100).toFixed(6)) : n);
}

function vatFractionFromPercent(pct: string): string {
  const trimmed = String(pct).replace("%", "").trim();
  if (!trimmed) return "";
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return pct;
  return String(n / 100);
}

// A line's VAT % is submittable only if it is an explicit number in [0, 100].
function vatPercentInvalid(pct: string): boolean {
  const trimmed = String(pct).replace("%", "").trim();
  if (!trimmed) return true;
  const n = Number(trimmed);
  return !Number.isFinite(n) || n < 0 || n > 100;
}

function approveFormFromCase(kase: ClerkCase): ApproveForm {
  return {
    firmId: "",
    supplierPartyId: "",
    buyerPartyId: "",
    invoiceNumber: fieldValue(kase, "invoiceNumber"),
    issueDate: fieldValue(kase, "issueDate"),
    dueDate: fieldValue(kase, "dueDate"),
    currency: fieldValue(kase, "currency") || "NGN",
    category: "b2b",
    lines: (kase.extraction?.lines ?? []).map((l) => ({
      description: l.description ?? "",
      quantity: l.quantity ?? "1",
      unitPrice: l.unitPrice ?? "0",
      vatRate: vatPercentFromRaw(l.vatRate),
    })),
  };
}

function AnswerCard({ answer }: { answer: ClerkAnswer }) {
  if (!answer.answered) {
    return (
      <Alert data-testid="card-clerk-refusal">
        <ShieldCheck className="h-4 w-4" aria-hidden="true" />
        <AlertTitle>The Clerk declined to answer</AlertTitle>
        <AlertDescription>{answer.refusalReason}</AlertDescription>
      </Alert>
    );
  }
  return (
    <Card data-testid="card-clerk-answer">
      <CardContent className="pt-6 space-y-3">
        <p className="text-base">{answer.proposition}</p>
        {answer.facts && answer.facts.length > 0 && (
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
        <p className="text-xs text-muted-foreground">
          Source: {answer.citation} · approved claim{" "}
          <code>{answer.claimKey}</code> v{answer.claimVersion}
        </p>
      </CardContent>
    </Card>
  );
}

// ---- Health tab -----------------------------------------------------------
// Read-only operational metrics for the Clerk: case flow, ask refusals and
// inference quality per model+prompt cohort. Numbers come straight from
// /clerk/metrics; the window selector re-queries the server.

const HEALTH_WINDOWS = [7, 30, 90];

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
function fmtEvalDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function fmtRatePct(rate: number | null | undefined): string {
  if (rate === null || rate === undefined) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  return `${Math.round(ms)} ms`;
}

// Token counts get grouping separators so 1234567 reads as 1,234,567.
function fmtTokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return Math.round(n).toLocaleString();
}

// Estimated spend is usually cents per window, so allow up to 4 decimals.
// null means the server has no per-token rates configured for the models used.
function fmtUsd(usd: number | null | undefined): string {
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
function casesTileDetail(cases: ClerkMetricsCases): string | undefined {
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
function overrideRateClass(rate: number): string {
  if (rate > 0.25) return "text-red-600 dark:text-red-400 font-medium";
  if (rate > 0.1) return "text-amber-700 dark:text-amber-400 font-medium";
  return "";
}

function StatTile({
  label,
  value,
  detail,
  testId,
}: {
  label: string;
  value: string;
  detail?: string;
  testId: string;
}) {
  return (
    <Card data-testid={testId}>
      <CardContent className="pt-6 space-y-1">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="text-2xl font-bold tabular-nums">{value}</p>
        {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
      </CardContent>
    </Card>
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

function HealthPanel() {
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
          description: `Field accuracy ${fmtRatePct(run.accuracy)} · injection resisted ${run.injectionResisted}/${run.injectionFixtures} across ${run.fixtureCount} fixtures.`,
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

      {isLoading ? (
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
              value={fmtRatePct(metrics.ask.refusalRate)}
              detail={`${metrics.ask.refused} of ${metrics.ask.total} questions refused`}
              testId="stat-refusal-rate"
            />
            <StatTile
              label="Invalid inference rate"
              value={fmtRatePct(metrics.inference.invalidRate)}
              detail={`error rate ${fmtRatePct(metrics.inference.errorRate)} of ${metrics.inference.total} calls`}
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
                            {fmtRatePct(c.overrideRate)}
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
      )}

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
                          {fmtRatePct(r.accuracy)}
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
    </div>
  );
}

function ConfidenceBadge({ confidence }: { confidence: number }) {
  const pct = Math.round(confidence * 100);
  const tone =
    confidence >= 0.9 ? "text-muted-foreground" : "text-amber-700 dark:text-amber-400 font-medium";
  return <span className={`text-xs tabular-nums ${tone}`}>{pct}%</span>;
}

// Clickable party-match chips under the supplier/buyer selects. Suggestions
// are only ever suggestions: clicking one sets the select, and the dropdown
// stays fully usable for anything else.
function PartySuggestionChips({
  suggestions,
  value,
  onPick,
  testId,
}: {
  suggestions: ClerkPartySuggestion[];
  value: string;
  onPick: (partyId: string) => void;
  testId: string;
}) {
  if (suggestions.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 pt-1" data-testid={testId}>
      {suggestions.map((s) => (
        <button
          key={s.partyId}
          type="button"
          onClick={() => onPick(s.partyId)}
          className={`${pillClasses(value === s.partyId ? "blue" : "slate")} hover:opacity-80 transition-opacity`}
          data-testid={`${testId}-${s.partyId}`}
        >
          {s.legalName} · {Math.round(s.confidence * 100)}%
          {s.tinScore === 1 && (
            <span className="text-[10px] uppercase font-semibold">
              TIN match
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

export function ClerkWorkspace() {
  usePageTitle("Clerk");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [disabledBanner, setDisabledBanner] = useState(false);

  // Paged case queue. The Capture tab only ever shows extraction cases, so
  // that kind filter now travels to the server with the page bounds (any
  // filter change would restart from the first page — offset only ever grows
  // within one filter set). Only the page at `offset` is a live query;
  // earlier pages are kept in local state and re-appended below.
  const [offset, setOffset] = useState(0);
  const [earlierCases, setEarlierCases] = useState<ClerkCase[]>([]);
  const caseParams: ListClerkCasesParams = {
    kind: "extraction",
    limit: PAGE_SIZE,
    offset,
  };
  const {
    data: casePage,
    isLoading,
    error,
    refetch,
  } = useListClerkCases(caseParams, {
    query: { queryKey: getListClerkCasesQueryKey(caseParams) },
  });

  // The queue shifts while paging (a new capture pushes every row down one
  // slot), so a case can be returned by two page fetches — dedupe by id to
  // keep React keys unique.
  const cases = useMemo(() => {
    const seen = new Set<string>();
    const merged: ClerkCase[] = [];
    for (const c of [...earlierCases, ...(casePage ?? [])]) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      merged.push(c);
    }
    return merged;
  }, [earlierCases, casePage]);

  // A short page is the end of the queue. When the total is an exact
  // multiple of PAGE_SIZE the last click fetches one empty page — harmless.
  const hasMoreCases = (casePage?.length ?? 0) === PAGE_SIZE;
  const loadingMoreCases = isLoading && offset > 0;
  const loadMoreCases = () => {
    if (!casePage) return;
    setEarlierCases((prev) => [...prev, ...casePage]);
    setOffset((o) => o + PAGE_SIZE);
  };

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { data: selected } = useGetClerkCase(selectedId ?? "", {
    query: {
      queryKey: getGetClerkCaseQueryKey(selectedId ?? ""),
      enabled: selectedId != null,
    },
  });

  // Capture form
  const [captureOpen, setCaptureOpen] = useState(false);
  const [captureText, setCaptureText] = useState("");
  const [captureFile, setCaptureFile] = useState<File | null>(null);
  const [captureVoice, setCaptureVoice] = useState<File | null>(null);
  // Duplicate guard: a 409 DUPLICATE_SOURCE on create means this exact
  // document content already has a live case. We hold the rejected payload
  // verbatim so "Create anyway" resubmits it byte-identical with
  // allowDuplicate: true. Cleared on success, on cancel, and whenever the
  // operator changes any source input (the held payload would be stale).
  const [pendingDuplicate, setPendingDuplicate] = useState<{
    payload: ClerkCaseCreateInput;
    message: string;
  } | null>(null);

  // Decision form
  const [form, setForm] = useState<ApproveForm | null>(null);
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (selected && (selected.status === "extracted" || selected.status === "in_review")) {
      setForm(approveFormFromCase(selected));
    } else {
      setForm(null);
    }
    setReason("");
  }, [selected?.id, selected?.status]);

  const { data: firms } = useListFirms();
  const { data: parties } = useListParties();

  // Party-matching suggestions for the open approval form, fetched only
  // while the form is open for an extraction case. A failed fetch is silent:
  // suggestions are a convenience, the plain dropdowns keep working.
  const suggestionsCaseId =
    form != null && selected?.kind === "extraction" ? selected.id : null;
  const { data: partySuggestions } = useGetClerkPartySuggestions(
    suggestionsCaseId ?? "",
    {
      query: {
        queryKey: getGetClerkPartySuggestionsQueryKey(suggestionsCaseId ?? ""),
        enabled: suggestionsCaseId != null,
      },
    },
  );

  // Pre-select the top suggestion for any party slot the operator has not
  // picked yet. Only empty slots are ever filled — an operator's choice is
  // never overwritten, and the selects stay fully open to any other party.
  useEffect(() => {
    if (!partySuggestions) return;
    setForm((f) => {
      if (!f) return f;
      const supplierPartyId =
        f.supplierPartyId || (partySuggestions.supplier[0]?.partyId ?? "");
      const buyerPartyId =
        f.buyerPartyId || (partySuggestions.buyer[0]?.partyId ?? "");
      if (
        supplierPartyId === f.supplierPartyId &&
        buyerPartyId === f.buyerPartyId
      ) {
        return f;
      }
      return { ...f, supplierPartyId, buyerPartyId };
    });
  }, [partySuggestions, form]);

  const handleGatewayError = (err: unknown, fallback: string) => {
    if (killSwitchTripped(err)) {
      setDisabledBanner(true);
      toast({
        title: "Clerk is switched off",
        description:
          "The clerk_ai kill switch is disabled, so no AI calls are being made.",
        variant: "destructive",
      });
      return;
    }
    // Relay the server's own words when it sent any — typed rejections
    // (VOICE_UNREADABLE / VOICE_NO_SPEECH 422s, CASE_CLAIMED /
    // CASE_CLAIM_CONFLICT 409s) carry an actionable message.
    toast({
      title: "Something went wrong",
      description: serverErrorMessage(err) ?? fallback,
      variant: "destructive",
    });
  };

  const invalidateCases = () => {
    // Reset paging before invalidating: fresh data trumps scroll position.
    // Only the first page stays mounted, so the refetch starts from the top
    // of the queue instead of stitching stale appended pages onto new data.
    setEarlierCases([]);
    setOffset(0);
    // getListClerkCasesQueryKey({}) prefix-matches every paged/filtered
    // variant of the list, so all cached pages go stale together.
    queryClient.invalidateQueries({ queryKey: getListClerkCasesQueryKey({}) });
    if (selectedId) {
      queryClient.invalidateQueries({
        queryKey: getGetClerkCaseQueryKey(selectedId),
      });
    }
  };

  const createCase = useCreateClerkCase({
    mutation: {
      onSuccess: (kase) => {
        invalidateCases();
        setSelectedId(kase.id);
        setCaptureOpen(false);
        setCaptureText("");
        setCaptureFile(null);
        setCaptureVoice(null);
        setVoiceFromRecorder(false);
        setPendingDuplicate(null);
        setDisabledBanner(false);
        toast({
          title:
            kase.status === "failed"
              ? "Reading failed"
              : "Document read",
          description:
            kase.status === "failed"
              ? kase.failReason ?? "The Clerk could not read this document."
              : "Every value below still needs your eyes before anything happens.",
        });
      },
      onError: (e, variables) => {
        // 409 DUPLICATE_SOURCE: the same content already has a live case.
        // No toast — an inline panel lets the operator create anyway
        // (allowDuplicate: true) or back out.
        if (errorStatus(e) === 409) {
          setPendingDuplicate({
            payload: variables.data,
            message:
              serverErrorMessage(e) ??
              "This exact document already has a live case.",
          });
          return;
        }
        handleGatewayError(e, "Could not read the document.");
      },
    },
  });

  const decideCase = useDecideClerkCase({
    mutation: {
      onSuccess: (kase) => {
        invalidateCases();
        toast({
          title:
            kase.decisionAction === "approve"
              ? "Draft invoice created"
              : `Case ${kase.status}`,
          description:
            kase.decisionAction === "approve"
              ? "The Clerk never submits: the draft goes through the normal review and submission flow."
              : undefined,
        });
      },
      onError: (e) => handleGatewayError(e, "Could not record the decision."),
    },
  });

  // Claiming is optional (a solo operator can decide straight from
  // "extracted") — it just tells other operators someone is on the case. A
  // 409 means someone else won the race, so refetch to show the real claimant.
  const claimCase = useClaimClerkCase({
    mutation: {
      onSuccess: () => {
        invalidateCases();
        toast({
          title: "Case claimed",
          description:
            "You're on it — other operators now see this case as in review.",
        });
      },
      onError: (e) => {
        if (errorStatus(e) === 409) invalidateCases();
        handleGatewayError(e, "Could not claim the case.");
      },
    },
  });

  const releaseCase = useReleaseClerkCase({
    mutation: {
      onSuccess: () => {
        invalidateCases();
        toast({
          title: "Case released",
          description: "The case is back in the queue for any operator.",
        });
      },
      onError: (e) => {
        if (errorStatus(e) === 409) invalidateCases();
        handleGatewayError(e, "Could not release the case.");
      },
    },
  });

  // Retry is only valid for failed extraction cases — the server 409s
  // anything else, and handleGatewayError relays its words.
  const retryCase = useRetryClerkCase({
    mutation: {
      onSuccess: (kase) => {
        invalidateCases();
        toast({
          title:
            kase.status === "failed" ? "Reading failed again" : "Document read",
          description:
            kase.status === "failed"
              ? kase.failReason ?? "The Clerk still could not read this document."
              : "Every value below still needs your eyes before anything happens.",
        });
      },
      onError: (e) => handleGatewayError(e, "Could not retry the extraction."),
    },
  });

  const ask = useAskClerk({
    mutation: {
      onSuccess: () => {
        invalidateCases();
        setDisabledBanner(false);
      },
      onError: (e) => handleGatewayError(e, "Could not ask the Clerk."),
    },
  });
  const [question, setQuestion] = useState("");

  // In-browser voice recording (MediaRecorder). The recorded blob becomes a
  // File fed through the SAME captureVoice path as an attached audio file, so
  // submit, duplicate guard and post-success reset all behave identically.
  // Refs hold the live recorder and timer so unmount cleanup can reach them.
  const [isRecording, setIsRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [voiceFromRecorder, setVoiceFromRecorder] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Hide the button entirely where the APIs are missing (old browsers,
  // insecure origins) — a button that can only fail is worse than none.
  const recordingSupported =
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof window !== "undefined" &&
    "MediaRecorder" in window;

  const stopRecording = () => {
    // onstop assembles the blob, stops the mic tracks and clears the timer.
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  };

  const startRecording = async () => {
    if (isRecording || recorderRef.current) return;
    setPendingDuplicate(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      toast({
        title: "Microphone unavailable",
        description:
          "Microphone access was denied or no microphone was found — allow access in the browser, or attach an audio file instead.",
        variant: "destructive",
      });
      return;
    }
    // Default mimeType (typically audio/webm) — the backend transcriber
    // handles webm natively.
    const recorder = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      if (recordTimerRef.current != null) {
        clearInterval(recordTimerRef.current);
        recordTimerRef.current = null;
      }
      recorderRef.current = null;
      setIsRecording(false);
      const blob = new Blob(chunks, {
        type: recorder.mimeType || "audio/webm",
      });
      if (blob.size === 0) return;
      if (blob.size > MAX_VOICE_BYTES) {
        toast({
          title: "Recording too large",
          description:
            "Voice notes are capped at 5 MB — record a shorter note.",
          variant: "destructive",
        });
        return;
      }
      setCaptureVoice(new File([blob], "recording.webm", { type: blob.type }));
      setVoiceFromRecorder(true);
    };
    recorderRef.current = recorder;
    setIsRecording(true);
    setRecordSeconds(0);
    recorder.start();
    const startedAt = Date.now();
    recordTimerRef.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      setRecordSeconds(elapsed);
      // Hard cap — matches the ~90-second voice-note demo with headroom.
      if (
        elapsed >= MAX_RECORD_SECONDS &&
        recorderRef.current?.state === "recording"
      ) {
        recorderRef.current.stop();
      }
    }, 1000);
  };

  // Never leave the mic held after unmount (no dangling recording indicator).
  useEffect(() => {
    return () => {
      if (recordTimerRef.current != null) {
        clearInterval(recordTimerRef.current);
      }
      const rec = recorderRef.current;
      if (rec) {
        rec.stream.getTracks().forEach((t) => t.stop());
        if (rec.state !== "inactive") rec.stop();
        recorderRef.current = null;
      }
    };
  }, []);

  const submitCapture = async () => {
    if (captureVoice) {
      const b64 = await fileToBase64(captureVoice);
      createCase.mutate({
        data: {
          sourceType: "voice",
          audioBase64: b64,
          name: captureVoice.name,
        },
      });
    } else if (captureFile) {
      const isPdf =
        captureFile.type === "application/pdf" ||
        captureFile.name.toLowerCase().endsWith(".pdf");
      const b64 = await fileToBase64(captureFile);
      createCase.mutate({
        data: {
          sourceType: isPdf ? "pdf" : "image",
          name: captureFile.name,
          contentType: captureFile.type || undefined,
          ...(isPdf ? { pdfBase64: b64 } : { imageBase64: b64 }),
        },
      });
    } else if (captureText.trim()) {
      createCase.mutate({
        data: {
          sourceType: "text",
          name: "pasted-text.txt",
          text: captureText,
        },
      });
    }
  };

  const sortedCases = useMemo(
    () =>
      [...cases].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [cases],
  );

  const approveDisabled =
    !form ||
    !form.firmId ||
    !form.supplierPartyId ||
    !form.buyerPartyId ||
    !form.invoiceNumber.trim() ||
    !form.issueDate ||
    form.lines.length === 0 ||
    form.lines.some(
      (l) =>
        !l.description.trim() ||
        !l.quantity ||
        !l.unitPrice ||
        vatPercentInvalid(l.vatRate),
    );

  // Only the FIRST page's load blanks the whole workspace; loading a later
  // page keeps the rows already on screen and spins the Load more button.
  if (isLoading && offset === 0) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (error) return <QueryError thing="Clerk cases" onRetry={refetch} />;

  const setLine = (i: number, patch: Partial<InvoiceLineInput>) => {
    if (!form) return;
    setForm({
      ...form,
      lines: form.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)),
    });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Bot className="w-6 h-6" aria-hidden="true" /> Clerk
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          A shadow copilot for operators. It reads documents and quotes the
          claims register — it never files anything with the tax authority.
        </p>
      </div>

      {disabledBanner && (
        <Alert variant="destructive" data-testid="banner-clerk-disabled">
          <PowerOff className="h-4 w-4" aria-hidden="true" />
          <AlertTitle>Clerk is switched off</AlertTitle>
          <AlertDescription>
            The <code>clerk_ai</code> feature flag is disabled. No AI calls are
            made while it is off — re-enable it under Feature flags.
          </AlertDescription>
        </Alert>
      )}

      <Tabs defaultValue="capture">
        <TabsList>
          <TabsTrigger value="capture" data-testid="tab-capture">
            <FileUp className="w-4 h-4 mr-1" aria-hidden="true" /> Document
            capture
          </TabsTrigger>
          <TabsTrigger value="ask" data-testid="tab-ask">
            <MessageCircleQuestion className="w-4 h-4 mr-1" aria-hidden="true" />{" "}
            Ask Clerk
          </TabsTrigger>
          <TabsTrigger value="health" data-testid="tab-health">
            <Activity className="w-4 h-4 mr-1" aria-hidden="true" /> Health
          </TabsTrigger>
        </TabsList>

        <TabsContent value="capture" className="mt-4">
          <div className="grid gap-6 lg:grid-cols-3">
            <Card className="lg:col-span-1">
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <CardTitle className="text-base">Cases</CardTitle>
                <Button
                  size="sm"
                  onClick={() => setCaptureOpen((o) => !o)}
                  data-testid="button-new-capture"
                >
                  <Plus className="w-4 h-4 mr-1" aria-hidden="true" /> New
                </Button>
              </CardHeader>
              <CardContent className="space-y-3">
                {captureOpen && (
                  <div className="border rounded-md p-3 space-y-2">
                    <Label htmlFor="capture-file">
                      Invoice document (PDF or photo)
                    </Label>
                    <Input
                      id="capture-file"
                      type="file"
                      accept=".pdf,image/png,image/jpeg,image/webp"
                      onChange={(e) => {
                        setCaptureFile(e.target.files?.[0] ?? null);
                        setPendingDuplicate(null);
                      }}
                      disabled={captureVoice != null}
                      data-testid="input-capture-file"
                    />
                    <Label htmlFor="capture-voice">
                      or a voice note (max 5 MB)
                    </Label>
                    <Input
                      id="capture-voice"
                      type="file"
                      accept="audio/*"
                      onChange={(e) => {
                        const f = e.target.files?.[0] ?? null;
                        setPendingDuplicate(null);
                        setVoiceFromRecorder(false);
                        if (f && f.size > MAX_VOICE_BYTES) {
                          toast({
                            title: "Voice note too large",
                            description: `Voice notes are capped at 5 MB; this file is ${(
                              f.size /
                              (1024 * 1024)
                            ).toFixed(1)} MB. Record a shorter note.`,
                            variant: "destructive",
                          });
                          e.target.value = "";
                          setCaptureVoice(null);
                          return;
                        }
                        setCaptureVoice(f);
                      }}
                      disabled={captureFile != null || isRecording}
                      data-testid="input-voice-file"
                    />
                    {recordingSupported && (
                      <div className="flex items-center gap-2 flex-wrap">
                        <Button
                          type="button"
                          size="sm"
                          variant={isRecording ? "destructive" : "secondary"}
                          onClick={isRecording ? stopRecording : startRecording}
                          disabled={
                            createCase.isPending ||
                            (!isRecording && captureFile != null)
                          }
                          data-testid="button-record-voice"
                        >
                          <Mic className="w-4 h-4 mr-1" aria-hidden="true" />
                          {isRecording ? "Stop recording" : "Record voice note"}
                        </Button>
                        <span
                          className="text-xs text-muted-foreground tabular-nums"
                          aria-live="polite"
                          data-testid="text-record-elapsed"
                        >
                          {isRecording
                            ? `Recording… ${recordSeconds}s (stops at ${MAX_RECORD_SECONDS}s)`
                            : voiceFromRecorder && captureVoice != null
                              ? "Recorded note ready — recording.webm"
                              : ""}
                        </span>
                      </div>
                    )}
                    <p className="text-xs text-muted-foreground">
                      English voice notes; the audio is transcribed and only
                      the transcript is kept.
                    </p>
                    <p className="text-xs text-muted-foreground">
                      or paste the invoice text:
                    </p>
                    <Textarea
                      value={captureText}
                      onChange={(e) => {
                        setCaptureText(e.target.value);
                        setPendingDuplicate(null);
                      }}
                      placeholder="INVOICE No: ..."
                      rows={5}
                      disabled={captureFile != null || captureVoice != null}
                      data-testid="input-capture-text"
                    />
                    <Button
                      className="w-full"
                      onClick={submitCapture}
                      disabled={
                        createCase.isPending ||
                        (!captureFile &&
                          !captureVoice &&
                          captureText.trim().length < 10)
                      }
                      data-testid="button-run-capture"
                    >
                      {createCase.isPending
                        ? captureVoice
                          ? "Transcribing…"
                          : "Reading…"
                        : "Read with Clerk"}
                    </Button>
                    {pendingDuplicate && (
                      <Alert data-testid="banner-duplicate-source">
                        <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                        <AlertTitle>Already read this one?</AlertTitle>
                        <AlertDescription className="space-y-2">
                          <p>{pendingDuplicate.message}</p>
                          <div className="flex gap-2 flex-wrap">
                            <Button
                              size="sm"
                              onClick={() =>
                                createCase.mutate({
                                  data: {
                                    ...pendingDuplicate.payload,
                                    allowDuplicate: true,
                                  },
                                })
                              }
                              disabled={createCase.isPending}
                              data-testid="button-create-anyway"
                            >
                              {createCase.isPending
                                ? "Reading…"
                                : "Create anyway"}
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => setPendingDuplicate(null)}
                              data-testid="button-cancel-duplicate"
                            >
                              Cancel
                            </Button>
                          </div>
                        </AlertDescription>
                      </Alert>
                    )}
                  </div>
                )}
                {/* The query is already extraction-only (kind param), so no
                    client-side kind filter is needed here anymore. */}
                {sortedCases.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No documents read yet.
                  </p>
                ) : (
                  <div className="divide-y">
                    {sortedCases.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => setSelectedId(c.id)}
                        className={`w-full text-left flex items-center gap-2 py-2 -mx-2 px-2 rounded-md hover:bg-muted/50 ${
                          selectedId === c.id ? "bg-muted/60" : ""
                        }`}
                        data-testid={`row-case-${c.id}`}
                      >
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">
                            {c.sourceName ?? "Untitled"}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {formatDateTime(c.createdAt)}
                          </p>
                        </div>
                        {c.status === "in_review" && (
                          <span
                            className="text-[10px] uppercase text-muted-foreground"
                            data-testid={`indicator-claimed-${c.id}`}
                          >
                            claimed
                          </span>
                        )}
                        <span
                          className={pillClasses(
                            STATUS_TONE[c.status] ?? "slate",
                          )}
                        >
                          {c.status.replace("_", " ")}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                {(hasMoreCases || loadingMoreCases) && (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="w-full"
                    onClick={loadMoreCases}
                    disabled={loadingMoreCases}
                    data-testid="button-load-more-cases"
                  >
                    {loadingMoreCases ? "Loading…" : "Load more"}
                  </Button>
                )}
              </CardContent>
            </Card>

            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle className="text-base">
                  {selected
                    ? (selected.sourceName ?? "Case detail")
                    : "Case detail"}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {!selected ? (
                  <p className="text-sm text-muted-foreground">
                    Pick a case on the left, or read a new document.
                  </p>
                ) : (
                  <>
                    <div className="flex items-center gap-2 flex-wrap text-sm">
                      <span
                        className={pillClasses(
                          STATUS_TONE[selected.status] ?? "slate",
                        )}
                      >
                        {selected.status.replace("_", " ")}
                      </span>
                      {selected.extraction && (
                        <span className="text-xs text-muted-foreground">
                          read by {selected.extraction.model} (
                          {selected.extraction.promptVersion})
                        </span>
                      )}
                    </div>

                    {selected.status === "failed" && (
                      <Alert variant="destructive">
                        <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                        <AlertTitle>Reading failed</AlertTitle>
                        <AlertDescription className="space-y-2">
                          <p>
                            {selected.failReason ??
                              "The Clerk could not read this document. Enter the invoice manually."}
                          </p>
                          {/* Retry re-runs extraction on the stored source —
                              only failed extraction cases qualify (the server
                              409s anything else). */}
                          {selected.kind === "extraction" && (
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() =>
                                retryCase.mutate({ id: selected.id })
                              }
                              disabled={retryCase.isPending}
                              data-testid="button-retry-case"
                            >
                              {retryCase.isPending ? "Retrying…" : "Retry"}
                            </Button>
                          )}
                        </AlertDescription>
                      </Alert>
                    )}
                    {selected.status === "escalated" && (
                      <Alert>
                        <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                        <AlertTitle>Escalated</AlertTitle>
                        <AlertDescription>
                          {selected.decisionReason ??
                            "This case needs a human decision outside the Clerk."}
                        </AlertDescription>
                      </Alert>
                    )}

                    {selected.extraction && (
                      <div>
                        <p className="text-xs font-medium text-muted-foreground uppercase mb-1">
                          Extracted fields — amber rows need checking
                        </p>
                        <div className="border rounded-md divide-y text-sm">
                          {selected.extraction.fields.map((f) => (
                            <div
                              key={f.field}
                              className={`flex items-center gap-2 px-3 py-1.5 ${
                                f.flagged
                                  ? "bg-amber-50 dark:bg-amber-950/40"
                                  : ""
                              }`}
                              data-testid={`row-field-${f.field}`}
                            >
                              <code className="text-xs w-32 shrink-0">
                                {f.field}
                              </code>
                              <span className="flex-1 truncate">
                                {f.value ?? (
                                  <em className="text-muted-foreground">
                                    missing
                                  </em>
                                )}
                              </span>
                              {f.critical && (
                                <span className="text-[10px] uppercase text-muted-foreground">
                                  critical
                                </span>
                              )}
                              <ConfidenceBadge confidence={f.confidence} />
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {selected.status === "approved" &&
                      selected.createdInvoiceId && (
                        <Alert data-testid="banner-draft-created">
                          <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                          <AlertTitle>Draft invoice created</AlertTitle>
                          <AlertDescription>
                            The invoice was created as a DRAFT. It has not been
                            submitted — it follows the normal human submission
                            flow.
                          </AlertDescription>
                        </Alert>
                      )}

                    {form && (
                      <div className="border-t pt-4 space-y-3">
                        <p className="text-sm font-medium">
                          Review and approve — creates a draft invoice only
                        </p>
                        {/* Claiming is optional: deciding straight from
                            "extracted" stays possible (solo-operator fast
                            path). A claim only marks the case as actively
                            being reviewed so a second operator doesn't start
                            the same work. */}
                        {selected.status === "extracted" &&
                          !selected.claimedBy && (
                            <div className="flex items-center gap-2 flex-wrap">
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() =>
                                  claimCase.mutate({ id: selected.id })
                                }
                                disabled={claimCase.isPending}
                                data-testid="button-claim-case"
                              >
                                {claimCase.isPending
                                  ? "Claiming…"
                                  : "Claim for review"}
                              </Button>
                              <p className="text-xs text-muted-foreground">
                                Optional — deciding below works without
                                claiming.
                              </p>
                            </div>
                          )}
                        {selected.status === "in_review" && (
                          <div className="flex items-center gap-2 flex-wrap">
                            <span
                              className={pillClasses("amber")}
                              data-testid="badge-claimed"
                            >
                              Claimed by {shortActor(selected.claimedBy)} ·{" "}
                              {relativeTime(selected.claimedAt)}
                            </span>
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() =>
                                releaseCase.mutate({ id: selected.id })
                              }
                              disabled={releaseCase.isPending}
                              data-testid="button-release-case"
                            >
                              {releaseCase.isPending
                                ? "Releasing…"
                                : "Release"}
                            </Button>
                          </div>
                        )}
                        <div className="grid sm:grid-cols-3 gap-3">
                          <div className="space-y-1">
                            <Label>Firm</Label>
                            <Select
                              value={form.firmId}
                              onValueChange={(v) =>
                                setForm({ ...form, firmId: v })
                              }
                            >
                              <SelectTrigger data-testid="select-firm">
                                <SelectValue placeholder="Choose firm" />
                              </SelectTrigger>
                              <SelectContent>
                                {(firms ?? []).map((f) => (
                                  <SelectItem key={f.id} value={f.id}>
                                    {f.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-1">
                            <Label>Supplier party</Label>
                            <Select
                              value={form.supplierPartyId}
                              onValueChange={(v) =>
                                setForm({ ...form, supplierPartyId: v })
                              }
                            >
                              <SelectTrigger data-testid="select-supplier">
                                <SelectValue placeholder="Choose supplier" />
                              </SelectTrigger>
                              <SelectContent>
                                {(parties ?? []).map((p) => (
                                  <SelectItem key={p.id} value={p.id}>
                                    {p.legalName}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <PartySuggestionChips
                              suggestions={partySuggestions?.supplier ?? []}
                              value={form.supplierPartyId}
                              onPick={(partyId) =>
                                setForm({ ...form, supplierPartyId: partyId })
                              }
                              testId="suggestions-supplier"
                            />
                          </div>
                          <div className="space-y-1">
                            <Label>Buyer party</Label>
                            <Select
                              value={form.buyerPartyId}
                              onValueChange={(v) =>
                                setForm({ ...form, buyerPartyId: v })
                              }
                            >
                              <SelectTrigger data-testid="select-buyer">
                                <SelectValue placeholder="Choose buyer" />
                              </SelectTrigger>
                              <SelectContent>
                                {(parties ?? []).map((p) => (
                                  <SelectItem key={p.id} value={p.id}>
                                    {p.legalName}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <PartySuggestionChips
                              suggestions={partySuggestions?.buyer ?? []}
                              value={form.buyerPartyId}
                              onPick={(partyId) =>
                                setForm({ ...form, buyerPartyId: partyId })
                              }
                              testId="suggestions-buyer"
                            />
                          </div>
                        </div>
                        <div className="grid sm:grid-cols-4 gap-3">
                          <div className="space-y-1">
                            <Label htmlFor="apr-number">Invoice number</Label>
                            <Input
                              id="apr-number"
                              value={form.invoiceNumber}
                              onChange={(e) =>
                                setForm({
                                  ...form,
                                  invoiceNumber: e.target.value,
                                })
                              }
                              data-testid="input-approve-number"
                            />
                          </div>
                          <div className="space-y-1">
                            <Label htmlFor="apr-issue">Issue date</Label>
                            <Input
                              id="apr-issue"
                              type="date"
                              value={form.issueDate}
                              onChange={(e) =>
                                setForm({ ...form, issueDate: e.target.value })
                              }
                              data-testid="input-approve-issue-date"
                            />
                          </div>
                          <div className="space-y-1">
                            <Label htmlFor="apr-due">Due date</Label>
                            <Input
                              id="apr-due"
                              type="date"
                              value={form.dueDate}
                              onChange={(e) =>
                                setForm({ ...form, dueDate: e.target.value })
                              }
                              data-testid="input-approve-due-date"
                            />
                          </div>
                          <div className="space-y-1">
                            <Label>Category</Label>
                            <Select
                              value={form.category}
                              onValueChange={(v) =>
                                setForm({
                                  ...form,
                                  category:
                                    v as ClerkCaseDecisionInputCategory,
                                })
                              }
                            >
                              <SelectTrigger data-testid="select-category">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {CATEGORIES.map((c) => (
                                  <SelectItem key={c} value={c}>
                                    {c.toUpperCase()}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        </div>
                        <div className="space-y-2">
                          <Label>Lines</Label>
                          {form.lines.map((line, i) => (
                            <div
                              key={i}
                              className="grid grid-cols-12 gap-2"
                              data-testid={`row-line-${i}`}
                            >
                              <Input
                                className="col-span-6"
                                placeholder="Description"
                                value={line.description}
                                onChange={(e) =>
                                  setLine(i, { description: e.target.value })
                                }
                              />
                              <Input
                                className="col-span-2"
                                placeholder="Qty"
                                value={line.quantity}
                                onChange={(e) =>
                                  setLine(i, { quantity: e.target.value })
                                }
                              />
                              <Input
                                className="col-span-2"
                                placeholder="Unit price"
                                value={line.unitPrice}
                                onChange={(e) =>
                                  setLine(i, { unitPrice: e.target.value })
                                }
                              />
                              <Input
                                className="col-span-2"
                                placeholder="VAT %"
                                value={line.vatRate}
                                onChange={(e) =>
                                  setLine(i, { vatRate: e.target.value })
                                }
                              />
                            </div>
                          ))}
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor="apr-reason">
                            Reason (required to reject or escalate)
                          </Label>
                          <Textarea
                            id="apr-reason"
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                            rows={2}
                            data-testid="input-decision-reason"
                          />
                        </div>
                        <div className="flex gap-2 flex-wrap">
                          <Button
                            onClick={() =>
                              decideCase.mutate({
                                id: selected.id,
                                data: {
                                  action: "approve",
                                  firmId: form.firmId,
                                  supplierPartyId: form.supplierPartyId,
                                  buyerPartyId: form.buyerPartyId,
                                  invoiceNumber: form.invoiceNumber.trim(),
                                  issueDate: form.issueDate,
                                  dueDate: form.dueDate || null,
                                  currency: form.currency,
                                  category: form.category,
                                  lines: form.lines.map((l) => ({
                                    ...l,
                                    vatRate: vatFractionFromPercent(l.vatRate),
                                  })),
                                  reason: reason || null,
                                },
                              })
                            }
                            disabled={approveDisabled || decideCase.isPending}
                            data-testid="button-approve-case"
                          >
                            Approve as draft invoice
                          </Button>
                          <Button
                            variant="destructive"
                            onClick={() =>
                              decideCase.mutate({
                                id: selected.id,
                                data: { action: "reject", reason },
                              })
                            }
                            disabled={!reason.trim() || decideCase.isPending}
                            data-testid="button-reject-case"
                          >
                            Reject
                          </Button>
                          <Button
                            variant="secondary"
                            onClick={() =>
                              decideCase.mutate({
                                id: selected.id,
                                data: { action: "escalate", reason },
                              })
                            }
                            disabled={!reason.trim() || decideCase.isPending}
                            data-testid="button-escalate-case"
                          >
                            Escalate
                          </Button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="ask" className="mt-4">
          <div className="max-w-2xl space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  Ask about Nigerian tax rules
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <Textarea
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  placeholder="What VAT rate applies to a consulting invoice?"
                  rows={3}
                  data-testid="input-ask-question"
                />
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs text-muted-foreground">
                    Answers come only from the approved claims register — if a
                    question is not covered, the Clerk refuses and escalates.
                  </p>
                  <Button
                    onClick={() => ask.mutate({ data: { question } })}
                    disabled={question.trim().length < 3 || ask.isPending}
                    data-testid="button-ask"
                  >
                    {ask.isPending ? "Checking the register…" : "Ask"}
                  </Button>
                </div>
              </CardContent>
            </Card>
            {ask.data?.answer && <AnswerCard answer={ask.data.answer} />}
          </div>
        </TabsContent>

        <TabsContent value="health" className="mt-4">
          <HealthPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
