import { useMemo, useRef, useState } from "react";
import {
  useGetMe,
  useImportBankStatement,
  useListBankStatements,
  useListBankStatementProposals,
  useAcceptMatchProposal,
  useRejectMatchProposal,
  getListBankStatementsQueryKey,
  getListBankStatementProposalsQueryKey,
  type StatementImportResult,
  type MatchProposalView,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  Upload,
  Landmark,
  ScanSearch,
  CheckCircle2,
  XCircle,
  Lock,
  Check,
  X,
} from "lucide-react";
import { formatNaira, formatDate } from "@/lib/format";

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status?: unknown }).status === 404
  );
}

function percent(rate: number | string): string {
  const n = Number(rate);
  if (Number.isNaN(n)) return "—";
  return `${Math.round(n * 100)}%`;
}

const STATEMENT_BADGES: Record<string, string> = {
  validated: "bg-blue-100 text-blue-800 border-blue-200",
  committed: "bg-amber-100 text-amber-800 border-amber-200",
  reconciled: "bg-emerald-100 text-emerald-800 border-emerald-200",
};

const PROPOSAL_BADGES: Record<string, string> = {
  proposed: "bg-blue-100 text-blue-800 border-blue-200",
  accepted: "bg-emerald-100 text-emerald-800 border-emerald-200",
  rejected: "bg-red-100 text-red-800 border-red-200",
  superseded: "bg-slate-100 text-slate-600 border-slate-200",
};

// Greener as confidence rises so the strongest matches stand out at a glance.
function confidenceBadge(confidence: string): string {
  const n = Number(confidence);
  if (n >= 0.9) return "bg-emerald-100 text-emerald-800 border-emerald-200";
  if (n >= 0.7) return "bg-lime-100 text-lime-800 border-lime-200";
  if (n >= 0.5) return "bg-amber-100 text-amber-800 border-amber-200";
  return "bg-red-100 text-red-800 border-red-200";
}

export function Reconciliation() {
  const { data: me } = useGetMe();
  const clientPartyId = me?.clientPartyId || "";
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const importMut = useImportBankStatement();
  const accept = useAcceptMatchProposal();
  const reject = useRejectMatchProposal();
  const fileRef = useRef<HTMLInputElement>(null);

  const [csv, setCsv] = useState("");
  const [filename, setFilename] = useState<string | null>(null);
  const [report, setReport] = useState<StatementImportResult | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [decidingId, setDecidingId] = useState<string | null>(null);

  const {
    data: statements,
    isLoading: statementsLoading,
    error: statementsError,
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
  const { data: proposals, isLoading: proposalsLoading } =
    useListBankStatementProposals(selectedId || "", {
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

  const csvLines = useMemo(
    () =>
      csv
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean),
    [csv],
  );

  const onFile = async (file: File) => {
    try {
      const text = await file.text();
      setCsv(text);
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
    if (!clientPartyId || !csv.trim()) return;
    try {
      const res = await importMut.mutateAsync({
        data: {
          clientPartyId,
          csv,
          commit,
          ...(filename ? { filename } : {}),
        },
      });
      setReport(res);
      if (commit) {
        await queryClient.invalidateQueries();
        setCsv("");
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
      await queryClient.invalidateQueries();
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
        description: e instanceof Error ? e.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setDecidingId(null);
    }
  };

  if (isNotFound(statementsError)) {
    return (
      <div className="space-y-6 animate-in fade-in duration-500">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Reconciliation</h1>
          <p className="text-muted-foreground">
            Match bank-statement lines to your stamped invoices.
          </p>
        </div>
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <Lock className="w-10 h-10 text-muted-foreground mb-3" />
            <p className="font-medium">Reconciliation is not yet enabled for this firm</p>
            <p className="text-sm text-muted-foreground">
              Ask your operator to enable it, then come back here to upload bank statements.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Reconciliation</h1>
        <p className="text-muted-foreground">
          Upload your bank statement and we match every credit to an invoice.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">1. Add a bank statement (CSV)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv,text/plain"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
            />
            <Button variant="outline" onClick={() => fileRef.current?.click()}>
              <Upload className="w-4 h-4 mr-2" /> Upload CSV
            </Button>
          </div>
          <textarea
            className="w-full min-h-[140px] rounded-md border border-input bg-transparent p-3 text-sm font-mono"
            placeholder="…or paste your bank statement CSV here (first line = column headers)"
            value={csv}
            onChange={(e) => {
              setCsv(e.target.value);
              setFilename(null);
              setReport(null);
            }}
          />
          {csvLines.length > 0 && (
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
          disabled={!csv.trim() || importMut.isPending}
        >
          <ScanSearch className="w-4 h-4 mr-2" />
          {importMut.isPending ? "Working…" : "Check parsing"}
        </Button>
        {report && !report.committed && (
          <Button onClick={() => run(true)} disabled={!csv.trim() || importMut.isPending}>
            <Landmark className="w-4 h-4 mr-2" />
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
            <div className="flex flex-wrap items-center gap-4 text-sm">
              <span>
                Format:{" "}
                <span className="font-mono text-xs bg-muted rounded px-1.5 py-0.5">
                  {report.formatKey || "unknown"}
                </span>
              </span>
              <span>Lines: {report.lineCount}</span>
              <span className="text-emerald-700">Parsed: {report.parsedCount}</span>
              <span
                className={
                  report.parseRate < 1 ? "text-destructive" : "text-emerald-700"
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
                  {r.parseStatus === "invalid" ? (
                    <XCircle className="w-4 h-4 text-destructive mt-0.5 shrink-0" />
                  ) : (
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 mt-0.5 shrink-0" />
                  )}
                  <div className="min-w-0">
                    <p className="font-medium">
                      Line {r.lineNo}
                      {r.parseStatus === "parsed" ? (
                        <span className="font-normal">
                          {" "}
                          · {formatDate(r.valueDate)} ·{" "}
                          <span className="capitalize">{r.direction || "—"}</span>{" "}
                          {formatNaira(r.amount)}
                        </span>
                      ) : (
                        <span className="capitalize text-muted-foreground font-normal">
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
          ) : (statements || []).length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <Landmark className="w-10 h-10 text-muted-foreground mb-3" />
              <p className="font-medium">No statements yet</p>
              <p className="text-sm text-muted-foreground">
                Upload a bank CSV above to start reconciling.
              </p>
            </div>
          ) : (
            (statements || []).map((s) => (
              <button
                key={s.id}
                onClick={() => setSelectedId(s.id)}
                className={`w-full text-left border rounded-md px-3 py-2 transition-colors hover:border-primary/50 ${
                  selectedId === s.id ? "border-primary bg-primary/5" : ""
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium truncate">
                        {s.filename || s.formatKey}
                      </span>
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full border capitalize ${
                          STATEMENT_BADGES[s.status] ||
                          "bg-slate-100 text-slate-600 border-slate-200"
                        }`}
                      >
                        {s.status}
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
            {proposalsLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-16" />
                <Skeleton className="h-16" />
              </div>
            ) : (proposals || []).length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <ScanSearch className="w-10 h-10 text-muted-foreground mb-3" />
                {selectedStatement && selectedStatement.status !== "reconciled" ? (
                  <>
                    <p className="font-medium">Matching in progress…</p>
                    <p className="text-sm text-muted-foreground">
                      The statement is committed; proposals appear here as soon as
                      matching finishes (a few seconds).
                    </p>
                  </>
                ) : (
                  <>
                    <p className="font-medium">No match proposals</p>
                    <p className="text-sm text-muted-foreground">
                      None of this statement's credits matched an open invoice.
                    </p>
                  </>
                )}
              </div>
            ) : (
              (proposals || []).map((p) => (
                <div key={p.id} className="border rounded-md px-3 py-2 text-sm space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-semibold truncate">{p.invoiceNumber}</span>
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full border ${confidenceBadge(p.confidence)}`}
                      >
                        {percent(p.confidence)} match
                      </span>
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full border capitalize ${
                          PROPOSAL_BADGES[p.status] ||
                          "bg-slate-100 text-slate-600 border-slate-200"
                        }`}
                      >
                        {p.status}
                      </span>
                    </div>
                    {p.status === "proposed" && (
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          onClick={() => decide(p, "accept")}
                          disabled={decidingId === p.id}
                        >
                          <Check className="w-4 h-4 mr-1" />
                          {decidingId === p.id ? "Saving…" : "Accept"}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => decide(p, "reject")}
                          disabled={decidingId === p.id}
                        >
                          <X className="w-4 h-4 mr-1" /> Reject
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
                      <span className="font-medium">{formatNaira(p.lineAmount)}</span>
                    </span>
                    <span>
                      Invoice total:{" "}
                      <span className="font-medium">{formatNaira(p.invoiceTotal)}</span>
                    </span>
                    <span className="text-muted-foreground capitalize">
                      Invoice status: {p.invoiceStatus}
                    </span>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
