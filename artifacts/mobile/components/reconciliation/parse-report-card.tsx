import { Feather } from "@expo/vector-icons";
import type { StatementImportResult } from "@workspace/api-client-react";
import React from "react";
import { View } from "react-native";

import { AppText, Badge, Card, rowBetween } from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { formatCurrency, formatDate, humanize } from "@/lib/format";
import { formatLabel, MAX_REPORT_ROWS, percent } from "@/lib/reconciliation";

/** The dry-run parse report: what a commit would record, row by row. */
export function ParseReportCard({ report }: { report: StatementImportResult }) {
  const colors = useColors();
  return (
    <Card style={{ gap: 10 }}>
      <View style={rowBetween}>
        <AppText variant="label">Statement preview</AppText>
        <Badge
          label={formatLabel(report.formatKey)}
          tone={report.formatKey ? "info" : "neutral"}
        />
      </View>
      <AppText variant="caption" color={colors.mutedForeground}>
        {report.parsedCount} of {report.lineCount} row(s) read (
        {percent(report.parseRate)}). Nothing is saved yet. Rows with errors
        will be skipped when you save.
      </AppText>
      <View style={{ gap: 6 }}>
        {report.rows.slice(0, MAX_REPORT_ROWS).map((r) => (
          <ParseReportRow key={r.lineNo} row={r} />
        ))}
        {report.rows.length > MAX_REPORT_ROWS ? (
          <AppText variant="caption" color={colors.mutedForeground}>
            …and {report.rows.length - MAX_REPORT_ROWS} more row(s).
          </AppText>
        ) : null}
      </View>
    </Card>
  );
}

function ParseReportRow({
  row: r,
}: {
  row: StatementImportResult["rows"][number];
}) {
  const colors = useColors();
  return (
    <View style={{ flexDirection: "row", gap: 8 }}>
      <Feather
        name={r.parseStatus === "invalid" ? "x-circle" : "check-circle"}
        size={14}
        color={
          r.parseStatus === "invalid" ? colors.destructiveText : colors.success
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
          <AppText variant="caption" color={colors.destructiveText}>
            {r.error}
          </AppText>
        ) : null}
      </View>
    </View>
  );
}
