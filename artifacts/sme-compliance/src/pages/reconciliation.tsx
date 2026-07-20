import { useMemo, useState } from "react";
import { Link } from "wouter";
import {
  useGetMe,
  useImportBankStatement,
  useListBankStatements,
  useListBankStatementProposals,
  useAcceptMatchProposal,
  useRejectMatchProposal,
  useBulkAcceptMatchProposals,
  useAssistMatchProposals,
  getListBankStatementsQueryKey,
  getListBankStatementProposalsQueryKey,
  type StatementImportInput,
  type StatementImportResult,
  type MatchProposalView,
  type MatchAssist,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { FeatureUnavailable } from "@/components/feature-unavailable";
import { RequireClientScope } from "@/components/require-client-scope";
import { FilePickerButton } from "@/components/file-picker-button";
import { RowStatusIcon } from "@/components/row-status-icon";
import { ClerkDisabledBanner } from "@/components/clerk-disabled-banner";
import { usePageTitle } from "@/hooks/use-page-title";
import { useToast } from "@/hooks/use-toast";
import { isFeatureDisabled, serverErrorMessage } from "@/lib/errors";
import { fileToBase64, handleClerkGatewayError } from "@/lib/clerk";
import {
  isPdfStatementFile,
  statementPdfSizeError,
} from "@/lib/statement-file";
import {
  Landmark,
  ScanSearch,
  Check,
  Sparkles,
  X,
} from "lucide-react";
import {
  formatNaira,
  formatDate,
  humanize,
  statusLabel,
  statementStatusLabel,
  statementBadgeClasses,
  proposalStatusLabel,
  proposalBadgeClasses,
  confidenceBadgeClasses,
} from "@/lib/format";

function percent(rate: number | string): string {
  const n = Number(rate);
  if (Number.isNaN(n)) return "—";
  return `${Math.round(n * 100)}%`;
}

/**
 * The import request body for the current inputs. The scanned path's COMMIT
 * posts back the preview's `proposedCsv` (with the preview's formatKey
 * unchanged) instead of the PDF — the server refuses `pdfBase64` with
 * commit:true (contract 0.40.0), so the rows the client checked in the
 * preview are exactly the rows that commit; extraction can never silently
 * re-run between preview and commit. Editing or re-picking a file clears
 * `report`, which drops the held proposedCsv with it. A PDF preview from an
 * older server carries no proposedCsv; the PDF then rides along unchanged
 * and the server stays the authority on whether that commit is accepted.
 */
export function statementImportBody(args: {
  clientPartyId: string;
  csv: string;
  pdf: { name: string; base64: string } | null;
  report: StatementImportResult | null;
  commit: boolean;
  filename: string | null;
}): StatementImportInput {
  const proposedCsv =
    args.commit && args.pdf && args.report && !args.report.committed
      ? (args.report.proposedCsv ?? null)
      : null;
  return {
    clientPartyId: args.clientPartyId,
    ...(proposedCsv !== null
      ? {
          csv: proposedCsv,
          ...(args.report?.formatKey ? { formatKey: args.report.formatKey } : {}),
        }
      : args.pdf
        ? { pdfBase64: args.pdf.base64 }
        : { csv: args.csv }),
    commit: args.commit,
    ...(args.filename ? { filename: args.filename } : {}),
  };
}

export function Reconciliation() {
  usePageTitle("Reconciliation");
  const { data: me } = useGetMe();
  const clientPartyId = me?.clientPartyId || "";
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const importMut = useImportBankStatement();
  const accept = useAcceptMatchProposal();
  const reject = useRejectMatchProposal();
  const bulkAccept = useBulkAcceptMatchProposals();
  const assistMut = useAssistMatchProposals();

  // Clerk's read on an ambiguous line's candidates, keyed by the proposal
  // whose "Why this match?" was clicked. The ranking and highlights inside are
  // computed by the deterministic matcher; Clerk only phrases the comparison.
  const [assistById, setAssistById] = useState<Record<string, MatchAssist>>({});
  const [assistingId, setAssistingId] = useState<string | null>(null);

  const explainMatch = async (p: MatchProposalView) => {
    setAssistingId(p.id);
    try {
      const res = await assistMut.mutateAsync({
        data: { statementLineId: p.statementLineId },
      });
      setAssistById((m) => ({ ...m, [p.id]: res }));
    } catch (e) {
      toast({
        title: "Clerk couldn't explain this match",
        description: serverErrorMessage(e),
        variant: "destructive",
      });
    } finally {
      setAssistingId(null);
    }
  };

  const [csv, setCsv] = useState("");
  const [filename, setFilename] = useState<string | null>(null);
  // Scanned-statement path (contract 0.39.0): a picked PDF is held as base64
  // and sent as pdfBase64 instead of csv — Clerk reads it into lines
  // server-side. Exactly one of pdf / csv text is ever live.
  const [pdf, setPdf] = useState<{ name: string; base64: string } | null>(null);
  // Which path produced the current report: PDF preview rows are Clerk's
  // PROPOSAL, not a parsed export, so they get an explicit check-first banner.
  const [reportSource, setReportSource] = useState<"csv" | "pdf">("csv");
  // Kill-switch banner for the scanned path (503 CLERK_DISABLED) — the same
  // pattern as the capture page; the CSV path never touches the model.
  const [clerkDown, setClerkDown] = useState(false);
  const [report, setReport] = useState<StatementImportResult | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  // "Accept all" confirm step: the first click arms the button for exactly one
  // statement, the second fires. Keyed by statement id so switching statements
  // can never fire a stale confirm against the newly selected one.
  const [bulkArmedId, setBulkArmedId] = useState<string | null>(null);

  const {
    data: statements,
    isLoading: statementsLoading,
    isError: statementsIsError,
    error: statementsError,
    refetch: refetchStatements,
  } = useListBankStatements(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getListBankStatementsQueryKey({ clientPartyId }),
        retry: false,
        // Proposal generation runs async in the worker after a commit; keep
        // polling until every committed statement reports `reconciled`.
        refetchInterval: (query) =>
          (query.state.data ?? []).some((s) => s.status === "committed")
            ? 3000
            : false,
      },
    },
  );

  const selectedStatement = (statements ?? []).find((s) => s.id === selectedId);
  const {
    data: proposals,
    isLoading: proposalsLoading,
    isError: proposalsIsError,
    refetch: refetchProposals,
  } = useListBankStatementProposals(selectedId || "", {
    query: {
      enabled: !!selectedId,
      queryKey: getListBankStatementProposalsQueryKey(selectedId || ""),
      retry: false,
      // A just-committed statement has no proposals yet — poll until the
      // reconcile job finishes instead of freezing on an empty first fetch.
      refetchInterval:
        selectedStatement && selectedStatement.status !== "reconciled"
          ? 3000
          : false,
    },
  });

  const bulkArmed = !!selectedId && bulkArmedId === selectedId;

  // Statement lines with a pending proposal at/above the server's default 0.85
  // threshold. Bulk accept takes at most the best proposal per line, so the
  // count is per line — not per proposal — to keep the button label honest.
  const bulkEligibleCount = useMemo(() => {
    const lines = new Set<string>();
    (proposals ?? []).forEach((p) => {
      if (p.status === "proposed" && Number(p.confidence) >= 0.85) {
        lines.add(p.statementLineId);
      }
    });
    return lines.size;
  }, [proposals]);

  const csvLines = useMemo(
    () =>
      csv
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean),
    [csv],
  );

  // File-type sniff: a PDF routes to the scanned path (base64, size-guarded),
  // anything else stays on the unchanged CSV text path.
  const onFile = async (file: File) => {
    if (isPdfStatementFile(file.name, file.type)) {
      const sizeError = statementPdfSizeError(file.size);
      if (sizeError) {
        toast({
          title: "Scanned statement too large",
          description: sizeError,
          variant: "destructive",
        });
        return;
      }
      try {
        const base64 = await fileToBase64(file);
        setPdf({ name: file.name, base64 });
        setCsv("");
        setFilename(file.name);
        setReport(null);
        setClerkDown(false);
      } catch {
        toast({
          title: "Could not read file",
          description: "The PDF could not be read — try re-exporting it.",
          variant: "destructive",
        });
      }
      return;
    }
    try {
      const text = await file.text();
      setCsv(text);
      setPdf(null);
      setFilename(file.name);
      setReport(null);
    } catch {
      toast({
        title: "Could not read file",
        description: "Upload a plain-text CSV export from your bank.",
        variant: "destructive",
      });
    }
  };

  const run = async (commit: boolean) => {
    if (!clientPartyId || (!pdf && !csv.trim())) return;
    try {
      const res = await importMut.mutateAsync({
        data: statementImportBody({
          clientPartyId,
          csv,
          pdf,
          report,
          commit,
          filename,
        }),
      });
      setReport(res);
      setReportSource(pdf ? "pdf" : "csv");
      if (commit) {
        // Not awaited: a background refetch rejection must not surface as a
        // false "commit failed" error after the statement already committed.
        queryClient.invalidateQueries({
          queryKey: getListBankStatementsQueryKey({ clientPartyId }),
        });
        setCsv("");
        setPdf(null);
        setFilename(null);
        if (res.statementId) setSelectedId(res.statementId);
        toast({
          title: "Statement committed",
          description: `${res.parsedCount} of ${res.lineCount} line(s) recorded — review the match proposals below.`,
        });
      } else {
        toast({
          title: "Parse check complete",
          description: `${res.parsedCount} of ${res.lineCount} line(s) parsed.`,
        });
      }
    } catch (e) {
      if (pdf) {
        // The scanned path spends Clerk tokens, so it can hit the gateway's
        // guardrails: 503 kill switch raises the banner, 429 budget and the
        // typed intake rejections relay the server's own words (the capture
        // page's pattern).
        handleClerkGatewayError(e, {
          onDisabled: () => setClerkDown(true),
          toast,
          fallbackTitle: commit
            ? "Commit failed"
            : "Clerk couldn't read that statement",
        });
        return;
      }
      toast({
        title: commit ? "Commit failed" : "Parse check failed",
        description: e instanceof Error ? e.message : "Please check your CSV.",
        variant: "destructive",
      });
    }
  };

  const decide = async (proposal: MatchProposalView, action: "accept" | "reject") => {
    setDecidingId(proposal.id);
    try {
      if (action === "accept") {
        await accept.mutateAsync({ id: proposal.id });
      } else {
        await reject.mutateAsync({ id: proposal.id });
      }
      // Not awaited: a background refetch rejection must not surface as a false
      // "could not save decision" error after the decision already recorded.
      queryClient.invalidateQueries({
        queryKey: getListBankStatementsQueryKey({ clientPartyId }),
      });
      queryClient.invalidateQueries({
        queryKey: getListBankStatementProposalsQueryKey(selectedId || ""),
      });
      toast({
        title: action === "accept" ? "Match accepted" : "Match rejected",
        description:
          action === "accept"
            ? `${proposal.invoiceNumber} is now marked settled.`
            : `${proposal.invoiceNumber} stays outstanding.`,
      });
    } catch (e) {
      toast({
        title: "Could not save decision",
        description: serverErrorMessage(e),
        variant: "destructive",
      });
    } finally {
      setDecidingId(null);
    }
  };

  // Accepts the best pending proposal per statement line at/above the server's
  // default threshold, through the same accept path as the per-row button. A
  // failed row usually means the invoice was already settled (possible
  // duplicate payment) — those stay pending for a human decision.
  const runBulkAccept = async () => {
    if (!selectedId) return;
    if (!bulkArmed) {
      setBulkArmedId(selectedId);
      return;
    }
    setBulkArmedId(null);
    try {
      const res = await bulkAccept.mutateAsync({ id: selectedId });
      // Not awaited: a background refetch rejection must not surface as a false
      // "could not accept" error after the decisions already recorded.
      queryClient.invalidateQueries({
        queryKey: getListBankStatementsQueryKey({ clientPartyId }),
      });
      queryClient.invalidateQueries({
        queryKey: getListBankStatementProposalsQueryKey(selectedId || ""),
      });
      toast({
        title: `Accepted ${res.acceptedCount} of ${res.total} matches`,
        description:
          res.failedCount > 0
            ? `${res.failedCount} could not be accepted — likely already-settled invoices; review them below.`
            : undefined,
      });
    } catch (e) {
      toast({
        title: "Could not accept matches",
        description: serverErrorMessage(e),
        variant: "destructive",
      });
    }
  };

  if (isFeatureDisabled(statementsError)) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Reconciliation"
          description="Match bank-statement lines to your stamped invoices."
        />
        <FeatureUnavailable feature="Reconciliation" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reconciliation"
        description="Upload your bank statement and we match every credit to an invoice."
      />

      <RequireClientScope thing="reconciliation workspace">
        <div className="space-y-6">
          {clerkDown && (
            <ClerkDisabledBanner>
              Scanned-statement reading is paused. Upload your bank&apos;s CSV
              export instead, or try the PDF again later.
            </ClerkDisabledBanner>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                1. Add a bank statement (CSV or scanned PDF)
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <FilePickerButton
                  accept=".csv,.pdf,text/csv,text/plain,application/pdf"
                  label="Upload CSV or PDF"
                  onFile={onFile}
                />
              </div>
              <div>
                <Label htmlFor="statement-csv" className="sr-only">
                  Bank statement CSV
                </Label>
                <Textarea
                  id="statement-csv"
                  className="min-h-[140px] font-mono"
                  placeholder="…or paste your bank statement CSV here (first line = column headers)"
                  value={csv}
                  onChange={(e) => {
                    setCsv(e.target.value);
                    setPdf(null);
                    setFilename(null);
                    setReport(null);
                  }}
                />
              </div>
              {pdf && (
                <p
                  className="text-sm text-muted-foreground"
                  data-testid="text-pdf-loaded"
                >
                  Loaded <span className="font-medium">{pdf.name}</span> — a
                  scanned statement. Clerk will read it into lines; run the
                  parse check to see what it found before committing.
                </p>
              )}
              {!pdf && csvLines.length > 0 && (
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">
                    {filename ? (
                      <>
                        Loaded <span className="font-medium">{filename}</span> —{" "}
                      </>
                    ) : null}
                    {csvLines.length} line(s) ready (including headers).
                  </p>
                  <pre className="text-xs font-mono bg-muted rounded-md p-3 overflow-x-auto">
                    {csvLines.slice(0, 6).join("\n")}
                    {csvLines.length > 6 ? "\n…" : ""}
                  </pre>
                </div>
              )}
            </CardContent>
          </Card>

          <div className="flex flex-wrap gap-3">
            <Button
              variant="outline"
              onClick={() => run(false)}
              disabled={(!pdf && !csv.trim()) || importMut.isPending}
            >
              <ScanSearch className="w-4 h-4 mr-2" aria-hidden="true" />
              {importMut.isPending
                ? pdf
                  ? "Clerk is reading…"
                  : "Working…"
                : "Check parsing"}
            </Button>
            {report && !report.committed && (
              <Button
                onClick={() => run(true)}
                disabled={(!pdf && !csv.trim()) || importMut.isPending}
              >
                <Landmark className="w-4 h-4 mr-2" aria-hidden="true" />
                {importMut.isPending ? "Working…" : "Commit statement"}
              </Button>
            )}
          </div>

          {report && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  {report.committed ? "Statement committed" : "Parse report"}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {reportSource === "pdf" && !report.committed && (
                  <Alert data-testid="banner-scanned-preview">
                    <Sparkles className="h-4 w-4" aria-hidden="true" />
                    <AlertTitle>
                      Clerk read this scanned statement
                    </AlertTitle>
                    <AlertDescription>
                      The rows below are what Clerk proposed from the PDF —
                      and exactly what will be committed. Check the dates,
                      amounts and directions against your statement; nothing
                      is saved until you press “Commit statement”.
                    </AlertDescription>
                  </Alert>
                )}
                <div className="flex flex-wrap items-center gap-4 text-sm">
                  <span>
                    Format:{" "}
                    <span className="font-mono text-xs bg-muted rounded px-1.5 py-0.5">
                      {report.formatKey || "unknown"}
                    </span>
                  </span>
                  <span>Lines: {report.lineCount}</span>
                  <span className="text-emerald-700 dark:text-emerald-400">
                    Parsed: {report.parsedCount}
                  </span>
                  <span
                    className={
                      report.parseRate < 1
                        ? "text-destructive"
                        : "text-emerald-700 dark:text-emerald-400"
                    }
                  >
                    Parse rate: {percent(report.parseRate)}
                  </span>
                </div>
                {!report.committed && (
                  <p className="text-xs text-muted-foreground">
                    Nothing has been saved yet — review the rows below, then press “Commit
                    statement”. Invalid rows are skipped on commit.
                  </p>
                )}
                <div className="space-y-2">
                  {report.rows.map((r) => (
                    <div
                      key={r.lineNo}
                      className={`flex items-start gap-2 text-sm border rounded-md px-3 py-2 ${
                        r.parseStatus === "invalid"
                          ? "border-destructive/40 bg-destructive/5"
                          : ""
                      }`}
                    >
                      <RowStatusIcon invalid={r.parseStatus === "invalid"} />
                      <div className="min-w-0">
                        <p className="font-medium">
                          Line {r.lineNo}
                          {r.parseStatus === "parsed" ? (
                            <span className="font-normal">
                              {" "}
                              · {formatDate(r.valueDate)} ·{" "}
                              {humanize(r.direction || "—")}{" "}
                              {formatNaira(r.amount)}
                            </span>
                          ) : (
                            <span className="text-muted-foreground font-normal">
                              {" "}
                              (invalid)
                            </span>
                          )}
                        </p>
                        {r.narration && (
                          <p className="text-xs text-muted-foreground truncate">{r.narration}</p>
                        )}
                        {r.error && <p className="text-xs text-destructive mt-1">{r.error}</p>}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">2. Your statements</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {statementsLoading ? (
                <div className="space-y-3">
                  <Skeleton className="h-14" />
                  <Skeleton className="h-14" />
                </div>
              ) : statementsIsError ? (
                <QueryError thing="your bank statements" onRetry={() => refetchStatements()} />
              ) : (statements || []).length === 0 ? (
                <EmptyState
                  icon={Landmark}
                  title="No statements yet"
                  description="Upload a bank CSV or scanned PDF above to start reconciling."
                  className="px-0 py-8 justify-center"
                />
              ) : (
                (statements || []).map((s) => (
                  <button
                    key={s.id}
                    onClick={() => setSelectedId(s.id)}
                    aria-pressed={selectedId === s.id}
                    className={`w-full text-left border rounded-md px-3 py-2 transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
                      selectedId === s.id ? "border-primary bg-primary/5" : ""
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium truncate">
                            {s.filename || s.formatKey}
                          </span>
                          <span className={statementBadgeClasses(s.status)}>
                            {statementStatusLabel(s.status)}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">
                          {s.parsedCount} of {s.lineCount} line(s) parsed · Parse rate{" "}
                          {s.lineCount > 0 ? percent(s.parsedCount / s.lineCount) : "—"} · Uploaded{" "}
                          {formatDate(s.createdAt)}
                        </p>
                      </div>
                      <span className="text-xs text-muted-foreground shrink-0">
                        {selectedId === s.id ? "Selected" : "View matches"}
                      </span>
                    </div>
                  </button>
                ))
              )}
            </CardContent>
          </Card>

          {selectedId && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  3. Match proposals
                  {selectedStatement
                    ? ` — ${selectedStatement.filename || selectedStatement.formatKey}`
                    : ""}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  Accepting a match records a settlement against the invoice and marks it as
                  settled. Rejecting keeps the invoice outstanding.
                </p>
                {bulkEligibleCount > 0 && (
                  <Button
                    size="sm"
                    onClick={runBulkAccept}
                    disabled={bulkAccept.isPending || decidingId !== null}
                    data-testid="button-bulk-accept"
                  >
                    <Check className="w-4 h-4 mr-1" aria-hidden="true" />
                    {bulkAccept.isPending
                      ? "Accepting…"
                      : bulkArmed
                        ? "Click again to confirm"
                        : `Accept all ≥ 85% (${bulkEligibleCount})`}
                  </Button>
                )}
                {proposalsLoading ? (
                  <div className="space-y-3">
                    <Skeleton className="h-16" />
                    <Skeleton className="h-16" />
                  </div>
                ) : proposalsIsError ? (
                  <QueryError thing="match proposals" onRetry={() => refetchProposals()} />
                ) : (proposals || []).length === 0 ? (
                  <EmptyState icon={ScanSearch} className="px-0 py-8 justify-center">
                    {selectedStatement && selectedStatement.status !== "reconciled" ? (
                      <>
                        <p className="font-semibold">Matching in progress…</p>
                        <p className="text-sm text-muted-foreground">
                          The statement is committed; proposals appear here as soon as
                          matching finishes (a few seconds).
                        </p>
                      </>
                    ) : (
                      <>
                        <p className="font-semibold" data-testid="text-empty">
                          No match proposals
                        </p>
                        <p className="text-sm text-muted-foreground">
                          None of this statement's credits matched an open invoice.
                        </p>
                      </>
                    )}
                  </EmptyState>
                ) : (
                  (proposals || []).map((p) => (
                    <div key={p.id} className="border rounded-md px-3 py-2 text-sm space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0 flex-wrap">
                          <Link
                            href={`/invoices/${p.invoiceId}`}
                            className="font-semibold truncate hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
                            data-testid={`link-proposal-invoice-${p.id}`}
                          >
                            {p.invoiceNumber}
                          </Link>
                          <span className={confidenceBadgeClasses(p.confidence)}>
                            {percent(p.confidence)} match
                          </span>
                          <span className={proposalBadgeClasses(p.status)}>
                            {proposalStatusLabel(p.status)}
                          </span>
                        </div>
                        {p.status === "proposed" && (
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              onClick={() => decide(p, "accept")}
                              disabled={decidingId === p.id}
                            >
                              <Check className="w-4 h-4 mr-1" aria-hidden="true" />
                              {decidingId === p.id ? "Saving…" : "Accept"}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => decide(p, "reject")}
                              disabled={decidingId === p.id}
                            >
                              <X className="w-4 h-4 mr-1" aria-hidden="true" /> Reject
                            </Button>
                          </div>
                        )}
                      </div>
                      <p className="text-muted-foreground">
                        {p.buyerName} · statement line {p.lineNo ?? "—"} of{" "}
                        {formatDate(p.lineDate)}
                      </p>
                      {p.narration && (
                        <p className="text-xs font-mono text-muted-foreground truncate">
                          {p.narration}
                        </p>
                      )}
                      <div className="flex flex-wrap gap-4 text-xs">
                        <span>
                          Line amount:{" "}
                          <span className="font-medium tabular-nums">
                            {formatNaira(p.lineAmount)}
                          </span>
                        </span>
                        <span>
                          Invoice total:{" "}
                          <span className="font-medium tabular-nums">
                            {formatNaira(p.invoiceTotal)}
                          </span>
                        </span>
                        <span className="text-muted-foreground">
                          Invoice status: {statusLabel(p.invoiceStatus)}
                        </span>
                      </div>
                      {p.status === "proposed" &&
                        Number(p.confidence) < 0.85 &&
                        !assistById[p.id] && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={() => explainMatch(p)}
                            disabled={assistingId !== null}
                            data-testid={`button-assist-${p.id}`}
                          >
                            <Sparkles className="w-3.5 h-3.5 mr-1" aria-hidden="true" />
                            {assistingId === p.id
                              ? "Asking Clerk…"
                              : "Why this match?"}
                          </Button>
                        )}
                      {assistById[p.id] && (
                        <div
                          className="rounded-md border border-violet-200 dark:border-violet-900 bg-violet-50 dark:bg-violet-950/40 px-3 py-2 space-y-1"
                          data-testid={`assist-${p.id}`}
                        >
                          <p className="text-xs font-medium text-violet-800 dark:text-violet-300 flex items-center gap-1">
                            <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                            {assistById[p.id].source === "clerk"
                              ? "Clerk's read on this line"
                              : "Match evidence"}
                          </p>
                          <p className="text-sm">{assistById[p.id].explanation}</p>
                          {(assistById[p.id].ranked.find(
                            (r) => r.proposalId === p.id,
                          )?.highlights.length ?? 0) > 0 && (
                            <ul className="text-xs text-muted-foreground list-disc pl-4 space-y-0.5">
                              {assistById[p.id].ranked
                                .find((r) => r.proposalId === p.id)!
                                .highlights.map((h, i) => (
                                  <li key={i}>{h}</li>
                                ))}
                            </ul>
                          )}
                          <p className="text-xs text-muted-foreground">
                            Ranked by the deterministic matcher — accepting
                            stays your decision.
                          </p>
                        </div>
                      )}
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </RequireClientScope>
    </div>
  );
}
