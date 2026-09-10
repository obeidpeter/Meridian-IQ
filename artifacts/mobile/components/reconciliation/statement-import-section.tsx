import type { StatementImportResult } from "@workspace/api-client-react";
import React from "react";
import { Platform, View } from "react-native";

import { AppButton, AppText, Card, TextField } from "@/components/ui";
import { useColors } from "@/hooks/useColors";

import { ParseReportCard } from "./parse-report-card";

/**
 * "Add a statement": pick or paste a bank CSV, check the parse, commit —
 * with the dry-run report as a sibling card until the commit clears it.
 */
export function StatementImportSection({
  csv,
  filename,
  report,
  csvLineCount,
  busy,
  onPickFile,
  onChangeCsv,
  onRunImport,
}: {
  csv: string;
  filename: string | null;
  report: StatementImportResult | null;
  csvLineCount: number;
  busy: boolean;
  onPickFile: () => void;
  onChangeCsv: (text: string) => void;
  onRunImport: (commit: boolean) => Promise<void>;
}) {
  const colors = useColors();
  return (
    <View style={{ gap: 12 }}>
      <AppText variant="heading">Add a statement</AppText>
      <Card style={{ gap: 12 }}>
        {Platform.OS !== "web" ? (
          <AppButton
            label={filename ? `File: ${filename}` : "Choose a CSV file"}
            icon="upload"
            variant="secondary"
            onPress={onPickFile}
            disabled={busy}
            testID="button-pick-csv"
          />
        ) : null}
        <TextField
          label="Or paste your bank CSV"
          value={csv}
          onChangeText={onChangeCsv}
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
          onPress={() => void onRunImport(false)}
          disabled={!csv.trim() || busy}
          loading={busy}
          testID="button-check-parse"
        />
        {report && !report.committed ? (
          <AppButton
            label="Commit statement"
            icon="check-circle"
            onPress={() => void onRunImport(true)}
            disabled={!csv.trim() || busy || report.parsedCount === 0}
            testID="button-commit-statement"
          />
        ) : null}
      </Card>

      {report && !report.committed ? <ParseReportCard report={report} /> : null}
    </View>
  );
}
