import { Stack } from "expo-router";
import React from "react";
import { RefreshControl, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { MatchProposalsSection } from "@/components/reconciliation/match-proposals-section";
import { StatementImportSection } from "@/components/reconciliation/statement-import-section";
import { StatementList } from "@/components/reconciliation/statement-list";
import {
  AppText,
  Banner,
  CardSkeleton,
  EmptyState,
  ErrorState,
  screenContent,
  stackHeaderOptions,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { useReconciliation } from "@/hooks/useReconciliation";

export default function ReconciliationScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const {
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
    acceptMut,
    rejectMut,
    onRefresh,
    pickFile,
    runImport,
    decide,
    csvLineCount,
    featureOff,
    busy,
  } = useReconciliation();

  return (
    <>
      <Stack.Screen options={stackHeaderOptions(colors, "Reconciliation")} />
      <KeyboardAwareScrollViewCompat
        style={{ backgroundColor: colors.background }}
        contentContainerStyle={[
          screenContent,
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
            message="Bank-statement matching is being rolled out gradually. Ask your accounting firm (or Valo support) to enable it for your business."
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
              <StatementImportSection
                csv={csv}
                filename={filename}
                report={report}
                csvLineCount={csvLineCount}
                busy={busy}
                onPickFile={pickFile}
                onChangeCsv={(t) => {
                  setCsv(t);
                  setFilename(null);
                  setReport(null);
                }}
                onRunImport={runImport}
              />
            ) : (
              <Banner
                tone="info"
                message="Bank statements are uploaded by your accounting firm. Matches for your business appear below as they're found."
              />
            )}

            <StatementList
              statements={statements}
              selectedId={selectedId}
              canImport={canImport}
              stalled={statementsPoll.stalled}
              onSelect={setSelectedId}
            />

            {selectedStatement ? (
              <MatchProposalsSection
                selectedStatement={selectedStatement}
                proposalsQuery={proposalsQuery}
                canDecide={canDecide}
                decidingId={decidingId}
                acceptPending={acceptMut.isPending}
                rejectPending={rejectMut.isPending}
                stalled={proposalsPoll.stalled}
                onDecide={decide}
              />
            ) : null}
          </View>
        )}
      </KeyboardAwareScrollViewCompat>
    </>
  );
}
