import { useEffect, useMemo, useState } from "react";
import {
  useListClerkCases,
  useGetClerkCase,
  useCreateClerkCase,
  useDecideClerkCase,
  useAskClerk,
  useGetClerkMetrics,
  useListFirms,
  useListParties,
  getListClerkCasesQueryKey,
  getGetClerkCaseQueryKey,
  getGetClerkMetricsQueryKey,
} from "@workspace/api-client-react";
import type {
  ClerkCase,
  ClerkAnswer,
  ClerkCaseDecisionInputCategory,
  InvoiceLineInput,
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

function killSwitchTripped(err: unknown): boolean {
  return errorStatus(err) === 503;
}

function fieldValue(kase: ClerkCase, field: string): string {
  return (
    kase.extraction?.fields.find((f) => f.field === field)?.value ?? ""
  );
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

function fmtRatePct(rate: number | null | undefined): string {
  if (rate === null || rate === undefined) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  return `${Math.round(ms)} ms`;
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
              detail={
                metrics.cases.avgDecisionMinutes != null
                  ? `avg decision ${Math.round(metrics.cases.avgDecisionMinutes)} min`
                  : undefined
              }
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
      )}
    </div>
  );
}

function ConfidenceBadge({ confidence }: { confidence: number }) {
  const pct = Math.round(confidence * 100);
  const tone =
    confidence >= 0.9 ? "text-muted-foreground" : "text-amber-700 dark:text-amber-400 font-medium";
  return <span className={`text-xs tabular-nums ${tone}`}>{pct}%</span>;
}

export function ClerkWorkspace() {
  usePageTitle("Clerk");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [disabledBanner, setDisabledBanner] = useState(false);

  const {
    data: cases,
    isLoading,
    error,
    refetch,
  } = useListClerkCases(
    {},
    { query: { queryKey: getListClerkCasesQueryKey({}) } },
  );

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
    const body = (err as { body?: { error?: string } } | null)?.body;
    toast({
      title: "Something went wrong",
      description: body?.error ?? fallback,
      variant: "destructive",
    });
  };

  const invalidateCases = () => {
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
      onError: (e) => handleGatewayError(e, "Could not read the document."),
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

  const submitCapture = async () => {
    if (captureFile) {
      const isPdf =
        captureFile.type === "application/pdf" ||
        captureFile.name.toLowerCase().endsWith(".pdf");
      const buf = await captureFile.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = "";
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      const b64 = btoa(binary);
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
      [...(cases ?? [])].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      ),
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

  if (isLoading) {
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
                      onChange={(e) =>
                        setCaptureFile(e.target.files?.[0] ?? null)
                      }
                      data-testid="input-capture-file"
                    />
                    <p className="text-xs text-muted-foreground">
                      or paste the invoice text:
                    </p>
                    <Textarea
                      value={captureText}
                      onChange={(e) => setCaptureText(e.target.value)}
                      placeholder="INVOICE No: ..."
                      rows={5}
                      disabled={captureFile != null}
                      data-testid="input-capture-text"
                    />
                    <Button
                      className="w-full"
                      onClick={submitCapture}
                      disabled={
                        createCase.isPending ||
                        (!captureFile && captureText.trim().length < 10)
                      }
                      data-testid="button-run-capture"
                    >
                      {createCase.isPending ? "Reading…" : "Read with Clerk"}
                    </Button>
                  </div>
                )}
                {sortedCases.filter((c) => c.kind === "extraction").length ===
                0 ? (
                  <p className="text-sm text-muted-foreground">
                    No documents read yet.
                  </p>
                ) : (
                  <div className="divide-y">
                    {sortedCases
                      .filter((c) => c.kind === "extraction")
                      .map((c) => (
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
                        <AlertDescription>
                          {selected.failReason ??
                            "The Clerk could not read this document. Enter the invoice manually."}
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
