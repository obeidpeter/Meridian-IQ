import { useMemo, useState } from "react";
import {
  useGetPortfolio,
  useGetAssessmentQuestionnaire,
  useRunAssessment,
  useAnalyzeVatRisk,
} from "@workspace/api-client-react";
import type {
  AssessmentReport,
  VatRiskReport,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { QueryError } from "@/components/query-error";
import { useToast } from "@/hooks/use-toast";
import { usePageTitle } from "@/hooks/use-page-title";
import {
  ClipboardCheck,
  ShieldAlert,
  CheckCircle2,
  AlertTriangle,
  FileSearch,
} from "lucide-react";
import {
  formatNaira,
  humanize,
  bandBadgeClasses,
  bandLabel,
  priorityBadgeClasses,
  pillClasses,
} from "@/lib/format";

// ADV-01 (readiness assessment) and ADV-02 (VAT-risk check): the R0 advisory
// field kit, surfaced for accountants. Both write to the spine as Engagements.

const CSV_PLACEHOLDER = `invoice number,supplier tin,supplier name,irn,csid,invoice amount,vat amount
INV-1003,20000000-0002,Adaeze Foods Ltd,IRN-DEMO-1003,CSID-DEMO-1003,720000,54000
INV-9001,99000000-0009,Ghost Traders Ltd,IRN-FAKE-1,CSID-FAKE-1,250000,18750`;

function AssessmentTab() {
  const { data: portfolio } = useGetPortfolio();
  const {
    data: template,
    isLoading,
    error,
    refetch,
  } = useGetAssessmentQuestionnaire();
  const run = useRunAssessment();
  const { toast } = useToast();

  const [clientPartyId, setClientPartyId] = useState("");
  const [answers, setAnswers] = useState<Record<string, boolean>>({});
  const [report, setReport] = useState<AssessmentReport | null>(null);

  // Answers describe one client — switching clients starts a fresh sheet.
  const selectClient = (id: string) => {
    if (id === clientPartyId) return;
    setClientPartyId(id);
    setAnswers({});
    setReport(null);
  };

  const questionCount = useMemo(
    () => (template?.sections ?? []).reduce((n, s) => n + s.questions.length, 0),
    [template],
  );
  const answeredCount = Object.keys(answers).length;

  const submit = () => {
    if (!clientPartyId) return;
    run.mutate(
      {
        data: {
          clientPartyId,
          answers: Object.entries(answers).map(([questionId, answer]) => ({
            questionId,
            answer,
          })),
        },
      },
      {
        onSuccess: (result) => {
          setReport(result);
          toast({
            title: `Assessment complete — ${result.score}% (${bandLabel(result.band)})`,
            description: "Findings are recorded on the client's engagement.",
          });
        },
        onError: () =>
          toast({ title: "Could not run assessment", variant: "destructive" }),
      },
    );
  };

  if (isLoading) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-28" />
        <Skeleton className="h-48" />
        <Skeleton className="h-48" />
      </div>
    );
  }

  if (error) {
    return (
      <QueryError
        thing="the assessment questionnaire"
        onRetry={() => refetch()}
      />
    );
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Client</CardTitle>
        </CardHeader>
        <CardContent>
          <Select value={clientPartyId} onValueChange={selectClient}>
            <SelectTrigger className="max-w-sm" data-testid="select-client">
              <SelectValue placeholder="Pick the client being assessed" />
            </SelectTrigger>
            <SelectContent>
              {portfolio && portfolio.clients.length === 0 ? (
                <p className="px-2 py-1.5 text-sm text-muted-foreground">
                  No clients yet — import your client book from the Client
                  import page first.
                </p>
              ) : (
                (portfolio?.clients ?? []).map((c) => (
                  <SelectItem key={c.clientPartyId} value={c.clientPartyId}>
                    {c.legalName}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {(template?.sections ?? []).map((section) => (
        <Card key={section.id} data-testid={`section-${section.id}`}>
          <CardHeader>
            <CardTitle className="text-base">{section.title}</CardTitle>
          </CardHeader>
          <CardContent className="divide-y">
            {section.questions.map((q) => (
              <div
                key={q.id}
                className="flex items-start justify-between gap-4 py-3"
              >
                <div>
                  <p className="text-sm font-medium">{q.prompt}</p>
                  {q.helpText && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {q.helpText}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-xs text-muted-foreground">
                    {answers[q.id] === undefined
                      ? "—"
                      : answers[q.id]
                        ? "Yes"
                        : "No"}
                  </span>
                  <Switch
                    checked={answers[q.id] ?? false}
                    onCheckedChange={(v) =>
                      setAnswers((a) => ({ ...a, [q.id]: v }))
                    }
                    aria-label={q.prompt}
                  />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      ))}

      <div className="flex items-center gap-3">
        <Button
          onClick={submit}
          disabled={!clientPartyId || run.isPending}
          data-testid="button-run-assessment"
        >
          <ClipboardCheck className="w-4 h-4 mr-1" aria-hidden="true" />
          {run.isPending ? "Scoring…" : "Run assessment"}
        </Button>
        <span className="text-sm text-muted-foreground">
          {answeredCount}/{questionCount} answered — unanswered counts as “no”.
        </span>
      </div>

      {report && (
        <Card data-testid="card-assessment-report">
          <CardHeader>
            <CardTitle className="flex items-center justify-between gap-2 text-base">
              <span>Gap report</span>
              <span className={bandBadgeClasses(report.band)}>
                {report.score}% · {bandLabel(report.band)}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {report.gaps.length === 0 ? (
              <p className="text-sm text-emerald-700 dark:text-emerald-400 flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4" aria-hidden="true" /> No gaps — this client is
                submission-ready.
              </p>
            ) : (
              <div className="space-y-2">
                {report.gaps.map((gap) => (
                  <div
                    key={gap.questionId}
                    className="flex items-start justify-between gap-3 border rounded-md p-2.5"
                  >
                    <div>
                      <p className="text-sm font-medium">{gap.prompt}</p>
                      <p className="text-xs text-muted-foreground">
                        {gap.section}
                      </p>
                    </div>
                    <span
                      className={`${priorityBadgeClasses(gap.severity)} shrink-0`}
                    >
                      {humanize(gap.severity)}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {report.remediation.length > 0 && (
              <div>
                <p className="text-sm font-medium mb-2">Remediation plan</p>
                <ol className="space-y-1.5 list-decimal list-inside">
                  {report.remediation.map((r, i) => (
                    <li key={i} className="text-sm">
                      {r.action}{" "}
                      <span className="text-muted-foreground">
                        — {r.rationale}
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function VatRiskTab() {
  const analyze = useAnalyzeVatRisk();
  const { toast } = useToast();
  const [buyerName, setBuyerName] = useState("");
  const [csv, setCsv] = useState("");
  const [report, setReport] = useState<VatRiskReport | null>(null);

  const submit = () => {
    if (!csv.trim()) return;
    analyze.mutate(
      { data: { buyerName: buyerName.trim() || undefined, csv } },
      {
        onSuccess: (result) => {
          setReport(result);
          toast({
            title: `${result.rowCount} rows checked — ${formatNaira(result.totalVatAtRisk)} at risk`,
          });
        },
        onError: () =>
          toast({ title: "Could not analyze ledger", variant: "destructive" }),
      },
    );
  };

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Supplier ledger</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5 max-w-sm">
            <Label htmlFor="vat-buyer">Buyer name (optional)</Label>
            <Input
              id="vat-buyer"
              value={buyerName}
              onChange={(e) => setBuyerName(e.target.value)}
              placeholder="Zenith Retail Group"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="vat-csv">
              Paste the ledger CSV (headers are matched loosely)
            </Label>
            <Textarea
              id="vat-csv"
              rows={7}
              className="font-mono text-xs"
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
              placeholder={CSV_PLACEHOLDER}
              data-testid="input-vat-csv"
            />
          </div>
          <Button
            onClick={submit}
            disabled={!csv.trim() || analyze.isPending}
            data-testid="button-analyze-vat"
          >
            <FileSearch className="w-4 h-4 mr-1" aria-hidden="true" />
            {analyze.isPending ? "Verifying stamps…" : "Analyze exposure"}
          </Button>
        </CardContent>
      </Card>

      {report && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Card data-testid="stat-rows">
              <CardContent className="pt-6">
                <p className="text-sm text-muted-foreground">Rows checked</p>
                <p className="text-2xl font-bold mt-1 tabular-nums">{report.rowCount}</p>
              </CardContent>
            </Card>
            <Card data-testid="stat-verified">
              <CardContent className="pt-6">
                <p className="text-sm text-muted-foreground">Verified stamps</p>
                <p className="text-2xl font-bold mt-1 tabular-nums text-emerald-700 dark:text-emerald-400">
                  {report.verifiedCount}
                </p>
              </CardContent>
            </Card>
            <Card data-testid="stat-at-risk">
              <CardContent className="pt-6">
                <p className="text-sm text-muted-foreground">Rows at risk</p>
                <p className="text-2xl font-bold mt-1 tabular-nums text-red-600 dark:text-red-400">
                  {report.atRiskCount}
                </p>
              </CardContent>
            </Card>
            <Card data-testid="stat-vat-at-risk">
              <CardContent className="pt-6">
                <p className="text-sm text-muted-foreground">Input VAT at risk</p>
                <p className="text-2xl font-bold mt-1 tabular-nums text-red-600 dark:text-red-400">
                  {formatNaira(report.totalVatAtRisk)}
                </p>
              </CardContent>
            </Card>
          </div>

          <Card data-testid="card-vat-rows">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <ShieldAlert className="w-4 h-4 text-primary" aria-hidden="true" /> Per-invoice
                results
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="divide-y">
                {report.rows.map((row) => (
                  <div
                    key={row.rowNumber}
                    className="flex items-center justify-between gap-3 py-2.5"
                    data-testid={`vat-row-${row.rowNumber}`}
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">
                        {row.invoiceNumber}
                        {row.supplierName ? ` · ${row.supplierName}` : ""}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        TIN {row.supplierTin} · VAT{" "}
                        {formatNaira(row.vatAmount)}
                        {row.detail ? ` · ${row.detail}` : ""}
                      </p>
                    </div>
                    {row.stampValid ? (
                      <span className={`${pillClasses("emerald")} shrink-0`}>
                        <CheckCircle2 className="w-3 h-3" aria-hidden="true" />{" "}
                        Valid
                      </span>
                    ) : (
                      <span className={`${pillClasses("red")} shrink-0`}>
                        <AlertTriangle className="w-3 h-3" aria-hidden="true" />{" "}
                        {formatNaira(row.vatAtRisk)} at risk
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

export function Advisory() {
  usePageTitle("Advisory");
  return (
    <div className="space-y-6">
      <div>
        <h1
          className="text-2xl md:text-3xl font-bold"
          data-testid="text-page-title"
        >
          Advisory toolkit
        </h1>
        <p className="text-muted-foreground mt-1">
          The field kit behind paid engagements — findings land in the spine as
          engagement data.
        </p>
      </div>
      <Tabs defaultValue="assessment">
        <TabsList>
          <TabsTrigger value="assessment" data-testid="tab-assessment">
            Readiness assessment
          </TabsTrigger>
          <TabsTrigger value="vat-risk" data-testid="tab-vat-risk">
            VAT-risk check
          </TabsTrigger>
        </TabsList>
        {/* forceMount keeps both tabs mounted so a generated report or a
            pasted CSV survives switching tabs and back. */}
        <TabsContent
          value="assessment"
          forceMount
          className="mt-5 data-[state=inactive]:hidden"
        >
          <AssessmentTab />
        </TabsContent>
        <TabsContent
          value="vat-risk"
          forceMount
          className="mt-5 data-[state=inactive]:hidden"
        >
          <VatRiskTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
