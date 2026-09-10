import { useQueryClient } from "@tanstack/react-query";
import {
  getGetDashboardSummaryQueryKey,
  getGetReceivablesSummaryQueryKey,
  getListBankStatementProposalsQueryKey,
  getListBankStatementsQueryKey,
  getListInvoicesQueryKey,
  useAcceptMatchProposal,
  useImportBankStatement,
  useListBankStatementProposals,
  useListBankStatements,
  useRejectMatchProposal,
} from "@workspace/api-client-react";
import type {
  MatchProposalView,
  StatementImportResult,
} from "@workspace/api-client-react";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { useCallback, useEffect, useMemo, useState } from "react";

import { usePendingPoll } from "@/hooks/usePendingPoll";
import { apiErrorMessage, isFeatureUnavailable } from "@/lib/api-error";
import {
  CSV_TOO_LARGE_MESSAGE,
  csvLineCount as countCsvLines,
  MAX_CSV_CHARS,
} from "@/lib/reconciliation";
import { useSession } from "@/lib/session";

/**
 * The Reconciliation screen's state and flows in one bag: the RBAC flags,
 * the statement list and its bounded matching poll, the selected statement's
 * proposals (polled on their own clock), and the import / decide flows with
 * their banners. The route file renders from this and nothing else.
 */
export function useReconciliation() {
  const queryClient = useQueryClient();
  const { me, clientPartyId } = useSession();

  // RBAC-aware UI: client users can review what their firm reconciled but the
  // server only lets statement.write/reconciliation.act holders import/decide.
  const canImport = !!me?.capabilities?.includes("statement.write");
  const canDecide = !!me?.capabilities?.includes("reconciliation.act");

  const [csv, setCsv] = useState("");
  const [filename, setFilename] = useState<string | null>(null);
  const [report, setReport] = useState<StatementImportResult | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [banner, setBanner] = useState<{
    tone: "success" | "error";
    message: string;
  } | null>(null);

  // Proposal generation runs async in the worker after a commit; poll until
  // every committed statement reports `reconciled` — but bounded: only while
  // this screen is focused, and never past the 10-minute cap (a statement
  // stuck matching that long is the worker's problem, not the phone's).
  const statementsPoll = usePendingPoll();
  // Keyed by the selected statement: switching statements is NEW work, so
  // the continuous-processing cap clock restarts instead of inheriting the
  // previous statement's elapsed time.
  const proposalsPoll = usePendingPoll(selectedId);

  const statementsQuery = useListBankStatements(
    { clientPartyId: clientPartyId ?? "" },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getListBankStatementsQueryKey({
          clientPartyId: clientPartyId ?? "",
        }),
        retry: false,
        refetchInterval: (query) =>
          statementsPoll.interval(
            (query.state.data ?? []).some((s) => s.status === "committed"),
          ),
      },
    },
  );

  const statements = useMemo(
    () => statementsQuery.data ?? [],
    [statementsQuery.data],
  );
  const selectedStatement = statements.find((s) => s.id === selectedId);

  // Auto-select the most recent statement so the matches section isn't dead on
  // arrival (the list is served newest-first).
  useEffect(() => {
    if (!selectedId && statements.length > 0) {
      setSelectedId(statements[0].id);
    }
  }, [selectedId, statements]);

  const proposalsQuery = useListBankStatementProposals(selectedId ?? "", {
    query: {
      enabled: !!selectedId,
      queryKey: getListBankStatementProposalsQueryKey(selectedId ?? ""),
      retry: false,
      // A just-committed statement has no proposals yet — poll (bounded,
      // focus-gated) until the reconcile worker finishes. (`validated`
      // previews never advance, so only `committed` warrants polling.)
      refetchInterval: () =>
        proposalsPoll.interval(selectedStatement?.status === "committed"),
    },
  });

  const importMut = useImportBankStatement();
  const acceptMut = useAcceptMatchProposal();
  const rejectMut = useRejectMatchProposal();

  // Manual state rather than `isRefetching`: the 3s matching poll would
  // otherwise flash the pull-to-refresh spinner on every background refetch.
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.allSettled([
        statementsQuery.refetch(),
        selectedId ? proposalsQuery.refetch() : Promise.resolve(),
      ]);
    } finally {
      setRefreshing(false);
    }
  }, [statementsQuery, proposalsQuery, selectedId]);

  const pickFile = async () => {
    setBanner(null);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: [
          "text/csv",
          "text/comma-separated-values",
          "text/plain",
          "application/csv",
        ],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (!asset) return;
      if (asset.size != null && asset.size > MAX_CSV_CHARS) {
        setBanner({ tone: "error", message: CSV_TOO_LARGE_MESSAGE });
        return;
      }
      const text = await new File(asset.uri).text();
      if (text.length > MAX_CSV_CHARS) {
        setBanner({ tone: "error", message: CSV_TOO_LARGE_MESSAGE });
        return;
      }
      setCsv(text);
      setFilename(asset.name);
      setReport(null);
    } catch {
      setBanner({
        tone: "error",
        message:
          "We couldn't read that file. Pick a plain CSV export from your bank app, or paste its contents below.",
      });
    }
  };

  const invalidateStatements = () =>
    queryClient.invalidateQueries({
      queryKey: getListBankStatementsQueryKey({
        clientPartyId: clientPartyId ?? "",
      }),
    });

  const runImport = async (commit: boolean) => {
    if (!clientPartyId || !csv.trim()) return;
    setBanner(null);
    if (csv.length > MAX_CSV_CHARS) {
      setBanner({
        tone: "error",
        message:
          "This statement is too large to process. Export a shorter date range and try again.",
      });
      return;
    }
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
        // Not awaited: a background refetch rejection must not surface as a
        // false "commit failed" error after the statement already committed.
        void invalidateStatements();
        setCsv("");
        setFilename(null);
        setReport(null);
        if (res.statementId) setSelectedId(res.statementId);
        setBanner({
          tone: "success",
          message: `Statement committed — ${res.parsedCount} of ${res.lineCount} line(s) recorded. Matching runs in the background.`,
        });
      } else if (res.parsedCount === 0) {
        setBanner({
          tone: "error",
          message:
            "None of the rows parsed. Check that the CSV starts with your bank's column headers.",
        });
      }
    } catch (error) {
      setBanner({
        tone: "error",
        message: apiErrorMessage(
          error,
          commit
            ? "We couldn't commit this statement. Please try again."
            : "We couldn't check this statement. Please try again.",
        ),
      });
    }
  };

  const decide = async (
    proposal: MatchProposalView,
    action: "accept" | "reject",
  ) => {
    setDecidingId(proposal.id);
    setBanner(null);
    try {
      if (action === "accept") {
        await acceptMut.mutateAsync({ id: proposal.id });
      } else {
        await rejectMut.mutateAsync({ id: proposal.id });
      }
      // Not awaited: the decision is already recorded; a refetch rejection must
      // not read as a failed decision. Accepting settles the invoice, so the
      // invoice list and dashboard need refreshing too.
      void queryClient.invalidateQueries({
        queryKey: getListBankStatementProposalsQueryKey(selectedId ?? ""),
      });
      void invalidateStatements();
      if (action === "accept") {
        void queryClient.invalidateQueries({
          queryKey: getListInvoicesQueryKey(),
        });
        void queryClient.invalidateQueries({
          queryKey: getGetDashboardSummaryQueryKey({
            clientPartyId: clientPartyId ?? "",
          }),
        });
        // A settled invoice leaves the receivables aging buckets.
        void queryClient.invalidateQueries({
          queryKey: getGetReceivablesSummaryQueryKey({
            clientPartyId: clientPartyId ?? "",
          }),
        });
      }
      setBanner({
        tone: "success",
        message:
          action === "accept"
            ? `${proposal.invoiceNumber} is now marked settled.`
            : `${proposal.invoiceNumber} stays outstanding.`,
      });
    } catch (error) {
      setBanner({
        tone: "error",
        message: apiErrorMessage(
          error,
          "We couldn't save that decision. Please try again.",
        ),
      });
    } finally {
      setDecidingId(null);
    }
  };

  const csvLineCount = useMemo(() => countCsvLines(csv), [csv]);

  const featureOff =
    statementsQuery.isError && isFeatureUnavailable(statementsQuery.error);

  const busy = importMut.isPending;

  return {
    canImport,
    canDecide,
    csv,
    setCsv,
    filename,
    setFilename,
    report,
    setReport,
    selectedId,
    setSelectedId,
    decidingId,
    banner,
    refreshing,
    statementsPoll,
    proposalsPoll,
    statementsQuery,
    statements,
    selectedStatement,
    proposalsQuery,
    importMut,
    acceptMut,
    rejectMut,
    onRefresh,
    pickFile,
    runImport,
    decide,
    csvLineCount,
    featureOff,
    busy,
  };
}

export type ReconciliationState = ReturnType<typeof useReconciliation>;
