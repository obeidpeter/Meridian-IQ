import { Feather } from "@expo/vector-icons";
import {
  DashboardSummaryPenaltyRisk,
  getGetDashboardSummaryQueryKey,
  useGetDashboardSummary,
} from "@workspace/api-client-react";
import type { ActivityItem, ComplianceDeadline } from "@workspace/api-client-react";
import { useRouter } from "expo-router";
import React, { useCallback } from "react";
import {
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  AppButton,
  AppText,
  Badge,
  BadgeTone,
  Card,
  CardSkeleton,
  Divider,
  ErrorState,
  StatTile,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import {
  countdownLabel,
  formatCurrency,
  formatDate,
  humanize,
  timeAgo,
} from "@/lib/format";
import { useSession } from "@/lib/session";

const RISK_TONE: Record<DashboardSummaryPenaltyRisk, BadgeTone> = {
  low: "success",
  medium: "warning",
  high: "critical",
};

const RISK_COPY: Record<DashboardSummaryPenaltyRisk, string> = {
  low: "You're on track. Keep issuing compliant invoices.",
  medium: "Some invoices need attention to avoid penalty exposure.",
  high: "Urgent: unresolved items may trigger significant penalties.",
};

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

export default function HomeScreen() {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { me, clientPartyId } = useSession();

  const query = useGetDashboardSummary(
    { clientPartyId: clientPartyId ?? "" },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getGetDashboardSummaryQueryKey({
          clientPartyId: clientPartyId ?? "",
        }),
      },
    },
  );

  const onRefresh = useCallback(() => {
    void query.refetch();
  }, [query]);

  const summary = query.data;
  const firstName = me?.fullName?.split(" ")[0];

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
      <View style={{ marginBottom: 20 }}>
        <AppText variant="caption" color={colors.mutedForeground}>
          {greeting().toUpperCase()}
        </AppText>
        <AppText variant="title" style={{ marginTop: 4 }}>
          {firstName ? firstName : "Welcome back"}
        </AppText>
      </View>

      {query.isLoading ? (
        <View style={{ gap: 12 }}>
          <CardSkeleton lines={2} />
          <View style={{ flexDirection: "row", gap: 12 }}>
            <CardSkeleton lines={1} />
            <CardSkeleton lines={1} />
          </View>
          <CardSkeleton lines={3} />
        </View>
      ) : query.isError ? (
        <ErrorState
          message="We couldn't load your dashboard."
          onRetry={onRefresh}
        />
      ) : summary ? (
        <View style={{ gap: 16 }}>
          <Card
            style={{
              backgroundColor:
                summary.penaltyRisk === "high"
                  ? colors.destructive
                  : summary.penaltyRisk === "medium"
                    ? colors.warning
                    : colors.primary,
            }}
          >
            <View style={styles.rowBetween}>
              <AppText variant="caption" color="#ffffff">
                PENALTY RISK
              </AppText>
              <Badge
                label={humanize(summary.penaltyRisk)}
                tone={RISK_TONE[summary.penaltyRisk]}
              />
            </View>
            <AppText variant="heading" color="#ffffff" style={{ marginTop: 10 }}>
              {RISK_COPY[summary.penaltyRisk]}
            </AppText>
            <Pressable
              onPress={() => router.push("/estimator")}
              style={({ pressed }) => [
                styles.riskLink,
                { opacity: pressed ? 0.7 : 1 },
              ]}
            >
              <AppText variant="label" color="#ffffff">
                Estimate my exposure
              </AppText>
              <Feather name="arrow-right" size={16} color="#ffffff" />
            </Pressable>
          </Card>

          <View style={{ flexDirection: "row", gap: 12 }}>
            <StatTile
              label="Unsubmitted"
              value={String(summary.unsubmittedCount)}
              tone={summary.unsubmittedCount > 0 ? colors.warning : undefined}
            />
            <StatTile
              label="At risk"
              value={String(summary.atRiskCount)}
              tone={summary.atRiskCount > 0 ? colors.destructive : undefined}
            />
          </View>
          <View style={{ flexDirection: "row", gap: 12 }}>
            <StatTile label="Stamped" value={String(summary.stampedCount)} />
            <StatTile
              label="Unsubmitted value"
              value={formatCurrency(summary.unsubmittedValue)}
            />
          </View>

          {summary.nextDeadline ? (
            <NextDeadlineCard
              deadline={summary.nextDeadline}
              onPress={() => router.push("/deadlines")}
            />
          ) : null}

          <View style={{ gap: 12 }}>
            <AppText variant="heading">Quick actions</AppText>
            <AppButton
              label="Create an invoice"
              icon="file-plus"
              onPress={() => router.push("/invoice")}
            />
            <AppButton
              label="Penalty estimator"
              icon="trending-up"
              variant="secondary"
              onPress={() => router.push("/estimator")}
            />
          </View>

          <View style={{ gap: 8 }}>
            <AppText variant="heading">Recent activity</AppText>
            {summary.recentActivity.length === 0 ? (
              <Card>
                <AppText variant="body" color={colors.mutedForeground}>
                  No recent activity yet.
                </AppText>
              </Card>
            ) : (
              <Card padded={false}>
                {summary.recentActivity.slice(0, 6).map((item, index) => (
                  <View key={item.id}>
                    {index > 0 ? <Divider /> : null}
                    <ActivityRow item={item} />
                  </View>
                ))}
              </Card>
            )}
          </View>
        </View>
      ) : null}
    </ScrollView>
  );
}

function NextDeadlineCard({
  deadline,
  onPress,
}: {
  deadline: ComplianceDeadline;
  onPress: () => void;
}) {
  const colors = useColors();
  return (
    <Pressable onPress={onPress}>
      <Card>
        <View style={styles.rowBetween}>
          <AppText variant="caption" color={colors.mutedForeground}>
            NEXT DEADLINE
          </AppText>
          <Feather name="chevron-right" size={18} color={colors.mutedForeground} />
        </View>
        <AppText variant="heading" style={{ marginTop: 8 }}>
          {deadline.title}
        </AppText>
        <View style={[styles.rowBetween, { marginTop: 8 }]}>
          <AppText variant="body" color={colors.mutedForeground}>
            {formatDate(deadline.dueDate)}
          </AppText>
          <AppText variant="label" color={colors.primary}>
            {countdownLabel(deadline.dueDate)}
          </AppText>
        </View>
      </Card>
    </Pressable>
  );
}

function ActivityRow({ item }: { item: ActivityItem }) {
  const colors = useColors();
  return (
    <View style={styles.activityRow}>
      <View style={[styles.dot, { backgroundColor: colors.accent }]}>
        <Feather name="file-text" size={14} color={colors.primary} />
      </View>
      <View style={{ flex: 1 }}>
        <AppText variant="label" numberOfLines={1}>
          {item.label}
        </AppText>
        {item.invoiceNumber ? (
          <AppText variant="caption" color={colors.mutedForeground}>
            {item.invoiceNumber}
            {item.status ? ` · ${humanize(item.status)}` : ""}
          </AppText>
        ) : item.status ? (
          <AppText variant="caption" color={colors.mutedForeground}>
            {humanize(item.status)}
          </AppText>
        ) : null}
      </View>
      <AppText variant="caption" color={colors.mutedForeground}>
        {timeAgo(item.at)}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: 20,
    paddingTop: 8,
    ...(Platform.OS === "web"
      ? { maxWidth: 640, alignSelf: "center", width: "100%" }
      : {}),
  },
  rowBetween: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  riskLink: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 14,
  },
  activityRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
  },
  dot: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
});
