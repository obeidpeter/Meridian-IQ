import type { BankStatement } from "@workspace/api-client-react";
import React from "react";
import { Pressable, View } from "react-native";

import { AppText, Badge, Card, EmptyState, rowBetween } from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { formatDate, humanize } from "@/lib/format";
import { PENDING_POLL_STALLED_MESSAGE } from "@/lib/pending-poll";
import {
  formatLabel,
  STATEMENT_STATUS_LABEL,
  STATEMENT_STATUS_TONE,
} from "@/lib/reconciliation";

/** "Your statements": the selectable list, newest first. */
export function StatementList({
  statements,
  selectedId,
  canImport,
  stalled,
  onSelect,
}: {
  statements: BankStatement[];
  selectedId: string | null;
  canImport: boolean;
  /** The bounded matching poll gave up — the quiet "still processing" line. */
  stalled: boolean;
  onSelect: (id: string) => void;
}) {
  const colors = useColors();
  return (
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
        statements.map((s: BankStatement) => (
          <StatementItem
            key={s.id}
            statement={s}
            selected={s.id === selectedId}
            onSelect={onSelect}
          />
        ))
      )}
      {stalled ? (
        <AppText variant="caption" color={colors.mutedForeground}>
          {PENDING_POLL_STALLED_MESSAGE}
        </AppText>
      ) : null}
    </View>
  );
}

function StatementItem({
  statement: s,
  selected,
  onSelect,
}: {
  statement: BankStatement;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const colors = useColors();
  return (
    <Pressable
      onPress={() => onSelect(s.id)}
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
            label={STATEMENT_STATUS_LABEL[s.status] ?? humanize(s.status)}
            tone={STATEMENT_STATUS_TONE[s.status] ?? "neutral"}
          />
        </View>
        <AppText variant="caption" color={colors.mutedForeground}>
          {s.parsedCount} of {s.lineCount} line(s) parsed · Uploaded{" "}
          {formatDate(s.createdAt)}
        </AppText>
        <AppText variant="caption" color={colors.primary}>
          {selected ? "Showing matches below" : "View matches"}
        </AppText>
      </Card>
    </Pressable>
  );
}
