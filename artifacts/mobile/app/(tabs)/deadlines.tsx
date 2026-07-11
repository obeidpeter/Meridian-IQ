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
  Platform,
  RefreshControl,
  ScrollView,
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
  const overdueCount = deadlines.filter((d) => d.status === "overdue").length;
  const dueSoonCount = deadlines.filter((d) => d.status === "due_soon").length;

  return (
    <ScrollView
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={[
        styles.content,
        { paddingBottom: insets.bottom + 100 },
      ]}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl
          refreshing={query.isRefetching}
          onRefresh={onRefresh}
          tintColor={colors.primary}
        />
      }
    >
      {query.isLoading ? (
        <View style={{ gap: 12 }}>
          <CardSkeleton lines={2} />
          <CardSkeleton lines={2} />
          <CardSkeleton lines={2} />
        </View>
      ) : query.isError ? (
        <ErrorState
          message="We couldn't load your compliance calendar."
          onRetry={onRefresh}
        />
      ) : deadlines.length === 0 ? (
        <EmptyState
          icon="check-circle"
          title="No upcoming deadlines"
          message="You're all caught up. New deadlines will appear here."
        />
      ) : (
        <View style={{ gap: 20 }}>
          {(overdueCount > 0 || dueSoonCount > 0) && (
            <View style={{ flexDirection: "row", gap: 12 }}>
              {overdueCount > 0 ? (
                <Card style={{ flex: 1, backgroundColor: colors.destructive }}>
                  <AppText variant="title" color="#ffffff">
                    {overdueCount}
                  </AppText>
                  <AppText variant="label" color="#ffffff">
                    Overdue
                  </AppText>
                </Card>
              ) : null}
              {dueSoonCount > 0 ? (
                <Card style={{ flex: 1, backgroundColor: colors.warning }}>
                  <AppText variant="title" color="#ffffff">
                    {dueSoonCount}
                  </AppText>
                  <AppText variant="label" color="#ffffff">
                    Due soon
                  </AppText>
                </Card>
              ) : null}
            </View>
          )}

          {groups.map((group) => (
            <View key={group.key} style={{ gap: 10 }}>
              <AppText variant="heading">{group.label}</AppText>
              <Card padded={false}>
                {group.items.map((d, index) => (
                  <View key={d.id}>
                    {index > 0 ? <Divider /> : null}
                    <DeadlineRow deadline={d} />
                  </View>
                ))}
              </Card>
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

function DeadlineRow({ deadline }: { deadline: ComplianceDeadline }) {
  const colors = useColors();
  const days = daysUntil(deadline.dueDate);
  const iconColor =
    deadline.severity === "critical"
      ? colors.destructive
      : deadline.severity === "warning"
        ? colors.warning
        : colors.mutedForeground;

  return (
    <View style={styles.row}>
      <View style={styles.rowIcon}>
        <Feather name={SEVERITY_ICON[deadline.severity]} size={20} color={iconColor} />
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
          <Badge label={humanize(deadline.status)} tone={STATUS_TONE[deadline.status]} />
          {deadline.status !== "met" ? (
            <AppText
              variant="caption"
              color={days < 0 ? colors.destructive : colors.mutedForeground}
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
    ...(Platform.OS === "web"
      ? { maxWidth: 640, alignSelf: "center", width: "100%" }
      : {}),
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
