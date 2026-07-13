import { Feather } from "@expo/vector-icons";
import {
  ComplianceDeadlineSeverity,
  ComplianceDeadlineStatus,
  getGetComplianceCalendarQueryKey,
  useGetComplianceCalendar,
} from "@workspace/api-client-react";
import type { ComplianceDeadline } from "@workspace/api-client-react";
import React, { useCallback, useMemo } from "react";
import {
  RefreshControl,
  ScrollView,
  SectionList,
  StyleSheet,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  AppText,
  Badge,
  BadgeTone,
  Card,
  CardSkeleton,
  Divider,
  EmptyState,
  ErrorState,
  webContentMax,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import {
  countdownLabel,
  daysUntil,
  formatDate,
  formatMonthYear,
  humanize,
  monthKey,
} from "@/lib/format";
import { useSession } from "@/lib/session";

const STATUS_TONE: Record<ComplianceDeadlineStatus, BadgeTone> = {
  upcoming: "info",
  due_soon: "warning",
  overdue: "critical",
  met: "success",
};

const SEVERITY_ICON: Record<
  ComplianceDeadlineSeverity,
  keyof typeof Feather.glyphMap
> = {
  info: "info",
  warning: "alert-circle",
  critical: "alert-triangle",
};

interface MonthGroup {
  key: string;
  label: string;
  items: ComplianceDeadline[];
}

function groupByMonth(deadlines: ComplianceDeadline[]): MonthGroup[] {
  const sorted = [...deadlines].sort(
    (a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime(),
  );
  const groups: Record<string, MonthGroup> = {};
  const order: string[] = [];
  for (const d of sorted) {
    const key = monthKey(d.dueDate);
    if (!groups[key]) {
      groups[key] = { key, label: formatMonthYear(d.dueDate), items: [] };
      order.push(key);
    }
    groups[key].items.push(d);
  }
  return order.map((k) => groups[k]);
}

export default function DeadlinesScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { clientPartyId } = useSession();

  const query = useGetComplianceCalendar(
    { clientPartyId: clientPartyId ?? "" },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getGetComplianceCalendarQueryKey({
          clientPartyId: clientPartyId ?? "",
        }),
      },
    },
  );

  const onRefresh = useCallback(() => {
    void query.refetch();
  }, [query]);

  const deadlines = useMemo(() => query.data ?? [], [query.data]);
  const groups = useMemo(() => groupByMonth(deadlines), [deadlines]);
  const sections = useMemo(
    () =>
      groups.map((group, index) => ({
        key: group.key,
        label: group.label,
        index,
        data: group.items,
      })),
    [groups],
  );
  const overdueCount = deadlines.filter((d) => d.status === "overdue").length;
  const dueSoonCount = deadlines.filter((d) => d.status === "due_soon").length;

  const refreshControl = (
    <RefreshControl
      refreshing={query.isRefetching}
      onRefresh={onRefresh}
      tintColor={colors.primary}
    />
  );
  const contentContainerStyle = [
    styles.content,
    { paddingBottom: insets.bottom + 100 },
  ];

  if (query.isLoading) {
    return (
      <ScrollView
        style={{ backgroundColor: colors.background }}
        contentContainerStyle={contentContainerStyle}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ gap: 12 }}>
          <CardSkeleton lines={2} />
          <CardSkeleton lines={2} />
          <CardSkeleton lines={2} />
        </View>
      </ScrollView>
    );
  }

  if (query.isError) {
    return (
      <ScrollView
        style={{ backgroundColor: colors.background }}
        contentContainerStyle={contentContainerStyle}
        showsVerticalScrollIndicator={false}
        refreshControl={refreshControl}
      >
        <ErrorState
          message="We couldn't load your compliance calendar."
          onRetry={onRefresh}
        />
      </ScrollView>
    );
  }

  if (deadlines.length === 0) {
    return (
      <ScrollView
        style={{ backgroundColor: colors.background }}
        contentContainerStyle={contentContainerStyle}
        showsVerticalScrollIndicator={false}
        refreshControl={refreshControl}
      >
        <EmptyState
          icon="check-circle"
          title="No upcoming deadlines"
          message="You're all caught up. New deadlines will appear here."
        />
      </ScrollView>
    );
  }

  const statHeader =
    overdueCount > 0 || dueSoonCount > 0 ? (
      <View style={{ flexDirection: "row", gap: 12, marginBottom: 20 }}>
        {overdueCount > 0 ? (
          <Card style={{ flex: 1, backgroundColor: colors.destructive }}>
            <AppText variant="title" color={colors.destructiveForeground}>
              {overdueCount}
            </AppText>
            <AppText variant="label" color={colors.destructiveForeground}>
              Overdue
            </AppText>
          </Card>
        ) : null}
        {dueSoonCount > 0 ? (
          <Card style={{ flex: 1, backgroundColor: colors.warning }}>
            <AppText variant="title" color={colors.warningForeground}>
              {dueSoonCount}
            </AppText>
            <AppText variant="label" color={colors.warningForeground}>
              Due soon
            </AppText>
          </Card>
        ) : null}
      </View>
    ) : null;

  // SectionList virtualizes rows so months/items aren't all mounted at once.
  // Each item is wrapped in a card "cell" with rounded top/bottom corners on
  // the first/last row so the group keeps its original single-card look.
  return (
    <SectionList
      style={{ backgroundColor: colors.background }}
      sections={sections}
      keyExtractor={(item) => item.id}
      renderItem={({ item, index, section }) => {
        const isFirst = index === 0;
        const isLast = index === section.data.length - 1;
        return (
          <View
            style={[
              {
                backgroundColor: colors.card,
                borderColor: colors.border,
                borderLeftWidth: StyleSheet.hairlineWidth,
                borderRightWidth: StyleSheet.hairlineWidth,
              },
              isFirst
                ? {
                    borderTopWidth: StyleSheet.hairlineWidth,
                    borderTopLeftRadius: colors.radius,
                    borderTopRightRadius: colors.radius,
                  }
                : null,
              isLast
                ? {
                    borderBottomWidth: StyleSheet.hairlineWidth,
                    borderBottomLeftRadius: colors.radius,
                    borderBottomRightRadius: colors.radius,
                  }
                : null,
            ]}
          >
            {!isFirst ? <Divider /> : null}
            <DeadlineRow deadline={item} />
          </View>
        );
      }}
      renderSectionHeader={({ section }) => (
        <AppText
          variant="heading"
          style={{ marginTop: section.index === 0 ? 0 : 20, marginBottom: 10 }}
        >
          {section.label}
        </AppText>
      )}
      ListHeaderComponent={statHeader}
      stickySectionHeadersEnabled={false}
      showsVerticalScrollIndicator={false}
      contentContainerStyle={contentContainerStyle}
      refreshControl={refreshControl}
    />
  );
}

function DeadlineRow({ deadline }: { deadline: ComplianceDeadline }) {
  const colors = useColors();
  const days = daysUntil(deadline.dueDate);
  // Fallbacks so an unmapped enum never sends `undefined` to Feather `name` or
  // a Badge tone.
  const statusTone = STATUS_TONE[deadline.status] ?? "neutral";
  const severityIcon = SEVERITY_ICON[deadline.severity] ?? "info";
  const iconColor =
    deadline.severity === "critical"
      ? colors.destructiveText
      : deadline.severity === "warning"
        ? colors.warning
        : colors.mutedForeground;
  const a11yLabel = [
    deadline.title,
    humanize(deadline.kind),
    formatDate(deadline.dueDate),
    humanize(deadline.status),
    deadline.status !== "met" ? countdownLabel(deadline.dueDate) : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <View style={styles.row} accessible accessibilityLabel={a11yLabel}>
      <View style={styles.rowIcon}>
        <Feather name={severityIcon} size={20} color={iconColor} />
      </View>
      <View style={{ flex: 1, gap: 4 }}>
        <AppText variant="label">{deadline.title}</AppText>
        <AppText variant="caption" color={colors.mutedForeground}>
          {humanize(deadline.kind)} · {formatDate(deadline.dueDate)}
        </AppText>
        {deadline.description ? (
          <AppText variant="caption" color={colors.mutedForeground} numberOfLines={2}>
            {deadline.description}
          </AppText>
        ) : null}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 2 }}>
          <Badge label={humanize(deadline.status)} tone={statusTone} />
          {deadline.status !== "met" ? (
            <AppText
              variant="caption"
              color={days < 0 ? colors.destructiveText : colors.mutedForeground}
            >
              {countdownLabel(deadline.dueDate)}
            </AppText>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: 20,
    paddingTop: 12,
    ...webContentMax,
  },
  row: {
    flexDirection: "row",
    gap: 12,
    padding: 14,
  },
  rowIcon: {
    width: 32,
    alignItems: "center",
    paddingTop: 2,
  },
});
