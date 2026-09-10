import { useMemo, useState } from "react";
import {
  useGetMe,
  useImportBankStatement,
  useListBankStatements,
  useListBankStatementProposals,
  useListBankStatementLines,
  useAcceptMatchProposal,
  useRejectMatchProposal,
  useBulkAcceptMatchProposals,
  useAssistMatchProposals,
  useSuggestNarrationMatches,
  getListBankStatementsQueryKey,
  getListBankStatementProposalsQueryKey,
  getListBankStatementLinesQueryKey,
  type StatementImportResult,
  type MatchProposalView,
  type MatchAssist,
  type BankStatementLine,
  type NarrationSuggestionsResult,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { usePageTitle } from "@/hooks/use-page-title";
import { useToast } from "@/hooks/use-toast";
import { isFeatureDisabled, serverErrorMessage } from "@/lib/errors";
import { fileToBase64, handleClerkGatewayError } from "@/lib/clerk";
import {
  isPdfStatementFile,
  statementPdfSizeError,
} from "@/lib/statement-file";
import { narrationSuggestVisible, statementImportBody } from "./helpers";

/**
 * Every hook, query, mutation and handler of the reconciliation page, in the
 * order the page has always called them (R126 split). Returns one bag the
 * shell hands down to the cards; the import flow's held proposedCsv/report
 * coupling (see statementImportBody) lives here on purpose.
 */
export function useReconciliation() {
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
  const narrationMut = useSuggestNarrationMatches();

  // The last narration run's headline numbers; carries its statementId so a
  // summary never renders against a different statement's panel.
  const [narrationSummary, setNarrationSummary] =
    useState<NarrationSuggestionsResult | null>(null);
  // Narration lane's own down-banner: 503 (clerk_ai kill switch) and 404 (the
  // lane's flag dark / older server) both mean "Clerk can't help right now".
  const [narrationDown, setNarrationDown] = useState(false);

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

  // Narration suggestions live on the LINES (BankStatementLine.
  // narrationSuggestion), not on the proposals view — fetch the expanded
  // statement's lines alongside its proposals and join by statementLineId.
  const { data: statementLines } = useListBankStatementLines(selectedId || "", {
    query: {
      enabled: !!selectedId,
      queryKey: getListBankStatementLinesQueryKey(selectedId || ""),
      retry: false,
    },
  });

  const linesById = useMemo(() => {
    const byId = new Map<string, BankStatementLine>();
    (statementLines ?? []).forEach((l) => byId.set(l.id, l));
    return byId;
  }, [statementLines]);

  const bulkArmed = !!selectedId && bulkArmedId === selectedId;

  const showNarrationSuggest = narrationSuggestVisible(
    proposals,
    me?.capabilities,
  );

  const runNarrationSuggest = async () => {
    if (!selectedId) return;
    setNarrationSummary(null);
    try {
      const res = await narrationMut.mutateAsync({
        data: { statementId: selectedId },
      });
      setNarrationSummary(res);
      // Not awaited: the suggestions are already recorded server-side, so a
      // background refetch rejection must not read as a failed run. The chips
      // read off the lines; proposals refetch too so the cards stay aligned
      // with the join.
      queryClient.invalidateQueries({
        queryKey: getListBankStatementLinesQueryKey(selectedId),
      });
      queryClient.invalidateQueries({
        queryKey: getListBankStatementProposalsQueryKey(selectedId),
      });
    } catch (e) {
      // 404 = the lane is dark (feature flag off / older server); 503 = the
      // clerk_ai kill switch — both raise the honest "matching stays manual"
      // banner. 429 budget and typed rejections relay the server's own words
      // through the shared gateway split.
      if (isFeatureDisabled(e)) {
        setNarrationDown(true);
        return;
      }
      handleClerkGatewayError(e, {
        onDisabled: () => setNarrationDown(true),
        toast,
        fallbackTitle: "Clerk couldn't read the narrations",
      });
    }
  };

  // Post-decision refresh, shared by the single accept/reject and bulk accept
  // paths. Not awaited: the decision(s) are already recorded server-side, so
  // a background refetch rejection must not surface as a false error toast.
  const invalidateMatchState = () => {
    queryClient.invalidateQueries({
      queryKey: getListBankStatementsQueryKey({ clientPartyId }),
    });
    queryClient.invalidateQueries({
      queryKey: getListBankStatementProposalsQueryKey(selectedId || ""),
    });
  };

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

  const decide = async (
    proposal: MatchProposalView,
    action: "accept" | "reject",
  ) => {
    setDecidingId(proposal.id);
    try {
      if (action === "accept") {
        await accept.mutateAsync({ id: proposal.id });
      } else {
        await reject.mutateAsync({ id: proposal.id });
      }
      invalidateMatchState();
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
      invalidateMatchState();
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

  // The CSV textarea's edit: typing drops any held PDF, filename and report.
  const editCsv = (value: string) => {
    setCsv(value);
    setPdf(null);
    setFilename(null);
    setReport(null);
  };

  return {
    statementsError,
    clerkDown,
    narrationDown,
    csv,
    editCsv,
    filename,
    pdf,
    csvLines,
    onFile,
    run,
    importMut,
    report,
    reportSource,
    statements,
    statementsLoading,
    statementsIsError,
    refetchStatements,
    selectedId,
    setSelectedId,
    selectedStatement,
    proposals,
    proposalsLoading,
    proposalsIsError,
    refetchProposals,
    linesById,
    bulkEligibleCount,
    bulkArmed,
    bulkAccept,
    runBulkAccept,
    showNarrationSuggest,
    narrationMut,
    runNarrationSuggest,
    narrationSummary,
    decidingId,
    assistingId,
    assistById,
    decide,
    explainMatch,
  };
}

export type ReconciliationState = ReturnType<typeof useReconciliation>;
