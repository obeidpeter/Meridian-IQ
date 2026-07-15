import { Feather } from "@expo/vector-icons";
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
  BankStatement,
  BankStatementStatus,
  MatchProposalView,
  MatchProposalViewStatus,
  StatementImportResult,
} from "@workspace/api-client-react";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { Stack, useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import {
  AppButton,
  AppText,
  Badge,
  BadgeTone,
  Banner,
  Card,
  CardSkeleton,
  Divider,
  EmptyState,
  ErrorState,
  rowBetween,
  stackHeaderOptions,
  TextField,
  webContentMax,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { apiErrorMessage, isFeatureUnavailable } from "@/lib/api-error";
import { formatCurrency, formatDate, humanize } from "@/lib/format";
import { useSession } from "@/lib/session";

// The server rejects statements above 4M characters (SEC-M3); catch that
// locally so a huge file fails fast with a clear message instead of a 413.
const MAX_CSV_CHARS = 4_000_000;

// Shown at both pickFile oversize checkpoints (the picker's size probe and the
// post-read length check) — one constant so the wording can't drift between
// them.
const CSV_TOO_LARGE_MESSAGE =
  "That file is too large for a bank statement. Export a shorter date range and try again.";

// How many parse-report rows to render — a full statement can be hundreds of
// lines and the report is a decision aid, not a ledger.
const MAX_REPORT_ROWS = 20;

const STATEMENT_STATUS_TONE: Record<BankStatementStatus, BadgeTone> = {
  validated: "info",
  committed: "warning",
  reconciled: "success",
};

const STATEMENT_STATUS_LABEL: Record<BankStatementStatus, string> = {
  validated: "Preview",
  committed: "Matching…",
  reconciled: "Ready",
};

const PROPOSAL_STATUS_TONE: Record<MatchProposalViewStatus, BadgeTone> = {
  proposed: "info",
  accepted: "success",
  rejected: "neutral",
  superseded: "neutral",
};

const PROPOSAL_STATUS_LABEL: Record<MatchProposalViewStatus, string> = {
  proposed: "Needs review",
  accepted: "Accepted",
  rejected: "Rejected",
  superseded: "Superseded",
};

// Friendly names for the bank export formats the parser recognises.
const FORMAT_LABEL: Record<string, string> = {
  gtb_csv: "GTBank",
  zenith_csv: "Zenith Bank",
  access_csv: "Access Bank",
  generic_csv: "Bank CSV",
};

function formatLabel(key: string | null | undefined): string {
  if (!key) return "Unknown format";
  return FORMAT_LABEL[key] ?? humanize(key);
}

function percent(rate: number | string): string {
  const n = Number(rate);
  if (Number.isNaN(n)) return "—";
  return `${Math.round(n * 100)}%`;
}

function confidenceTone(confidence: string): BadgeTone {
  const n = Number(confidence);
  if (Number.isNaN(n)) return "neutral";
  if (n >= 0.75) return "success";
  if (n >= 0.5) return "warning";
  return "neutral";
}

export default function ReconciliationScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
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

  const statementsQuery = useListBankStatements(
    { clientPartyId: clientPartyId ?? "" },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getListBankStatementsQueryKey({
          clientPartyId: clientPartyId ?? "",
        }),
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

  const statements = useMemo(() => statementsQuery.data ?? [], [statementsQuery.data]);
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
      // A just-committed statement has no proposals yet — poll until the
      // reconcile worker finishes. (`validated` previews never advance, so
      // only `committed` warrants polling.)
      refetchInterval:
        selectedStatement?.status === "committed" ? 3000 : false,
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

  const csvLineCount = useMemo(
    () => csv.split(/\r?\n/).filter((l) => l.trim()).length,
    [csv],
  );

  const featureOff =
    statementsQuery.isError && isFeatureUnavailable(statementsQuery.error);

  const busy = importMut.isPending;

  return (
    <>
      <Stack.Screen options={stackHeaderOptions(colors, "Reconciliation")} />
      <KeyboardAwareScrollViewCompat
        style={{ backgroundColor: colors.background }}
        contentContainerStyle={[
          styles.content,
          { paddingBottom: insets.bottom + 48 },
        ]}
        bottomOffset={20}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void onRefresh()}
            tintColor={colors.primary}
          />
        }
      >
        {statementsQuery.isLoading ? (
          <View style={{ gap: 12 }}>
            <CardSkeleton lines={2} />
            <CardSkeleton lines={3} />
          </View>
        ) : featureOff ? (
          <EmptyState
            icon="lock"
            title="Reconciliation isn't enabled yet"
            message="Bank-statement matching is being rolled out gradually. Ask your accounting firm (or MeridianIQ support) to enable it for your business."
          />
        ) : statementsQuery.isError ? (
          <ErrorState
            message="We couldn't load your bank statements."
            onRetry={() => void statementsQuery.refetch()}
          />
        ) : (
          <View style={{ gap: 20 }}>
            <AppText variant="body" color={colors.mutedForeground}>
              Upload a bank statement and we match every credit to a stamped
              invoice — so nothing goes unreported.
            </AppText>

            {banner ? (
              <Banner tone={banner.tone} message={banner.message} />
            ) : null}

            {canImport ? (
              <View style={{ gap: 12 }}>
                <AppText variant="heading">Add a statement</AppText>
                <Card style={{ gap: 12 }}>
                  {Platform.OS !== "web" ? (
                    <AppButton
                      label={filename ? `File: ${filename}` : "Choose a CSV file"}
                      icon="upload"
                      variant="secondary"
                      onPress={pickFile}
                      disabled={busy}
                      testID="button-pick-csv"
                    />
                  ) : null}
                  <TextField
                    label="Or paste your bank CSV"
                    value={csv}
                    onChangeText={(t) => {
                      setCsv(t);
                      setFilename(null);
                      setReport(null);
                    }}
                    placeholder="First line = column headers (GTBank, Zenith, Access and generic exports are recognised)"
                    multiline
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={{ minHeight: 110, textAlignVertical: "top" }}
                  />
                  {csvLineCount > 0 ? (
                    <AppText variant="caption" color={colors.mutedForeground}>
                      {csvLineCount} line(s) ready, including headers.
                    </AppText>
                  ) : null}
                  <AppButton
                    label={busy ? "Working…" : "Check parsing"}
                    icon="search"
                    variant={report && !report.committed ? "ghost" : "primary"}
                    onPress={() => void runImport(false)}
                    disabled={!csv.trim() || busy}
                    loading={busy}
                    testID="button-check-parse"
                  />
                  {report && !report.committed ? (
                    <AppButton
                      label="Commit statement"
                      icon="check-circle"
                      onPress={() => void runImport(true)}
                      disabled={!csv.trim() || busy || report.parsedCount === 0}
                      testID="button-commit-statement"
                    />
                  ) : null}
                </Card>

                {report && !report.committed ? (
                  <Card style={{ gap: 10 }}>
                    <View style={rowBetween}>
                      <AppText variant="label">Parse report</AppText>
                      <Badge
                        label={formatLabel(report.formatKey)}
                        tone={report.formatKey ? "info" : "neutral"}
                      />
                    </View>
                    <AppText variant="caption" color={colors.mutedForeground}>
                      {report.parsedCount} of {report.lineCount} row(s) parsed (
                      {percent(report.parseRate)}). Nothing is saved yet —
                      invalid rows are skipped when you commit.
                    </AppText>
                    <View style={{ gap: 6 }}>
                      {report.rows.slice(0, MAX_REPORT_ROWS).map((r) => (
                        <View
                          key={r.lineNo}
                          style={{ flexDirection: "row", gap: 8 }}
                        >
                          <Feather
                            name={
                              r.parseStatus === "invalid"
                                ? "x-circle"
                                : "check-circle"
                            }
                            size={14}
                            color={
                              r.parseStatus === "invalid"
                                ? colors.destructiveText
                                : colors.success
                            }
                            style={{ marginTop: 2 }}
                          />
                          <View style={{ flex: 1 }}>
                            <AppText variant="caption">
                              Line {r.lineNo}
                              {r.parseStatus === "parsed"
                                ? ` · ${r.valueDate ? formatDate(r.valueDate) : "—"} · ${humanize(r.direction ?? "")} ${formatCurrency(r.amount)}`
                                : " (invalid)"}
                            </AppText>
                            {r.narration ? (
                              <AppText
                                variant="caption"
                                color={colors.mutedForeground}
                                numberOfLines={1}
                              >
                                {r.narration}
                              </AppText>
                            ) : null}
                            {r.error ? (
                              <AppText
                                variant="caption"
                                color={colors.destructiveText}
                              >
                                {r.error}
                              </AppText>
                            ) : null}
                          </View>
                        </View>
                      ))}
                      {report.rows.length > MAX_REPORT_ROWS ? (
                        <AppText
                          variant="caption"
                          color={colors.mutedForeground}
                        >
                          …and {report.rows.length - MAX_REPORT_ROWS} more
                          row(s).
                        </AppText>
                      ) : null}
                    </View>
                  </Card>
                ) : null}
              </View>
            ) : (
              <Banner
                tone="info"
                message="Bank statements are uploaded by your accounting firm. Matches for your business appear below as they're found."
              />
            )}

            <View style={{ gap: 12 }}>
              <AppText variant="heading">Your statements</AppText>
              {statements.length === 0 ? (
                <EmptyState
                  icon="inbox"
                  title="No statements yet"
                  message={
                    canImport
                      ? "Add a bank CSV above to start matching payments to invoices."
                      : "When your firm uploads a bank statement, it appears here."
                  }
                />
              ) : (
                statements.map((s: BankStatement) => {
                  const selected = s.id === selectedId;
                  return (
                    <Pressable
                      key={s.id}
                      onPress={() => setSelectedId(s.id)}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      accessibilityLabel={`Statement ${s.filename || formatLabel(s.formatKey)}, ${STATEMENT_STATUS_LABEL[s.status] ?? humanize(s.status)}, ${s.parsedCount} of ${s.lineCount} lines parsed, uploaded ${formatDate(s.createdAt)}`}
                      testID={`statement-item-${s.id}`}
                    >
                      <Card
                        style={{
                          gap: 6,
                          borderWidth: 1,
                          borderColor: selected ? colors.primary : "transparent",
                        }}
                      >
                        <View style={rowBetween}>
                          <AppText
                            variant="label"
                            numberOfLines={1}
                            style={{ flex: 1, marginRight: 8 }}
                          >
                            {s.filename || formatLabel(s.formatKey)}
                          </AppText>
                          <Badge
                            label={
                              STATEMENT_STATUS_LABEL[s.status] ??
                              humanize(s.status)
                            }
                            tone={STATEMENT_STATUS_TONE[s.status] ?? "neutral"}
                          />
                        </View>
                        <AppText variant="caption" color={colors.mutedForeground}>
                          {s.parsedCount} of {s.lineCount} line(s) parsed ·
                          Uploaded {formatDate(s.createdAt)}
                        </AppText>
                        <AppText variant="caption" color={colors.primary}>
                          {selected ? "Showing matches below" : "View matches"}
                        </AppText>
                      </Card>
                    </Pressable>
                  );
                })
              )}
            </View>

            {selectedStatement ? (
              <View style={{ gap: 12 }}>
                <AppText variant="heading">Match proposals</AppText>
                <AppText variant="caption" color={colors.mutedForeground}>
                  Accepting a match records the payment against the invoice and
                  marks it settled. Rejecting keeps the invoice outstanding.
                </AppText>
                {proposalsQuery.isLoading ? (
                  <CardSkeleton lines={3} />
                ) : proposalsQuery.isError ? (
                  <ErrorState
                    message="We couldn't load the match proposals."
                    onRetry={() => void proposalsQuery.refetch()}
                  />
                ) : (proposalsQuery.data ?? []).length === 0 ? (
                  selectedStatement.status === "committed" ? (
                    <EmptyState
                      icon="loader"
                      title="Matching in progress…"
                      message="The statement is committed; proposals appear here as soon as matching finishes (a few seconds)."
                    />
                  ) : (
                    <EmptyState
                      icon="search"
                      title="No matches found"
                      message="None of this statement's credits matched an open invoice."
                    />
                  )
                ) : (
                  (proposalsQuery.data ?? []).map((p) => {
                    const deciding = decidingId === p.id;
                    return (
                      <Card key={p.id} style={{ gap: 8 }}>
                        <View style={rowBetween}>
                          <Pressable
                            onPress={() => router.push(`/invoices/${p.invoiceId}`)}
                            accessibilityRole="link"
                            accessibilityLabel={`Open invoice ${p.invoiceNumber}`}
                            hitSlop={8}
                          >
                            <AppText variant="label" color={colors.primary}>
                              {p.invoiceNumber}
                            </AppText>
                          </Pressable>
                          <View style={{ flexDirection: "row", gap: 6 }}>
                            <Badge
                              label={`${percent(p.confidence)} match`}
                              tone={confidenceTone(p.confidence)}
                            />
                            <Badge
                              label={
                                PROPOSAL_STATUS_LABEL[p.status] ??
                                humanize(p.status)
                              }
                              tone={PROPOSAL_STATUS_TONE[p.status] ?? "neutral"}
                            />
                          </View>
                        </View>
                        <AppText variant="caption" color={colors.mutedForeground}>
                          {p.buyerName} · line {p.lineNo ?? "—"}
                          {p.lineDate ? ` · ${formatDate(p.lineDate)}` : ""}
                        </AppText>
                        {p.narration ? (
                          <AppText
                            variant="caption"
                            color={colors.mutedForeground}
                            numberOfLines={2}
                          >
                            {p.narration}
                          </AppText>
                        ) : null}
                        <Divider />
                        <View style={rowBetween}>
                          <View>
                            <AppText variant="caption" color={colors.mutedForeground}>
                              Bank credit
                            </AppText>
                            <AppText variant="label">
                              {formatCurrency(p.lineAmount)}
                            </AppText>
                          </View>
                          <View style={{ alignItems: "flex-end" }}>
                            <AppText variant="caption" color={colors.mutedForeground}>
                              Invoice total
                            </AppText>
                            <AppText variant="label">
                              {formatCurrency(p.invoiceTotal)}
                            </AppText>
                          </View>
                        </View>
                        {p.status === "proposed" ? (
                          canDecide ? (
                            <View style={{ flexDirection: "row", gap: 10 }}>
                              <View style={{ flex: 1 }}>
                                <AppButton
                                  label="Accept"
                                  icon="check"
                                  onPress={() => void decide(p, "accept")}
                                  disabled={deciding}
                                  loading={deciding && acceptMut.isPending}
                                  testID={`button-accept-${p.id}`}
                                />
                              </View>
                              <View style={{ flex: 1 }}>
                                <AppButton
                                  label="Reject"
                                  icon="x"
                                  variant="secondary"
                                  onPress={() => void decide(p, "reject")}
                                  disabled={deciding}
                                  loading={deciding && rejectMut.isPending}
                                  testID={`button-reject-${p.id}`}
                                />
                              </View>
                            </View>
                          ) : (
                            <AppText
                              variant="caption"
                              color={colors.mutedForeground}
                            >
                              Your accounting firm reviews and confirms matches.
                            </AppText>
                          )
                        ) : null}
                      </Card>
                    );
                  })
                )}
              </View>
            ) : null}
          </View>
        )}
      </KeyboardAwareScrollViewCompat>
    </>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: 20,
    paddingTop: 16,
    ...webContentMax,
  },
});
