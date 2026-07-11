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

const RISK_COPY: Record<DashboardSummaryPenaltyRisk, string> = {
  low: "You're on track. Keep issuing compliant invoices.",
  medium: "Some invoices need attention to avoid penalty exposure.",
  high: "Urgent: unresolved items may trigger significant penalties.",
};

// Fallback copy when the API returns a penaltyRisk value we don't map, so a
// text child is never `undefined`.
const RISK_COPY_FALLBACK =
  "Review your compliance status to stay ahead of penalties.";

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
          <PenaltyRiskCard
            risk={summary.penaltyRisk}
            onEstimate={() => router.push("/estimator")}
          />

          <View style={{ flexDirection: "row", gap: 12 }}>
            <StatTile
              label="Unsubmitted"
              value={String(summary.unsubmittedCount)}
              tone={summary.unsubmittedCount > 0 ? colors.warning : undefined}
            />
            <StatTile
              label="At risk"
              value={String(summary.atRiskCount)}
              tone={summary.atRiskCount > 0 ? colors.destructiveText : undefined}
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
              label="Reconcile bank payments"
              icon="credit-card"
              variant="secondary"
              onPress={() => router.push("/reconciliation")}
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
                    <ActivityRow
                      item={item}
                      onPress={
                        item.invoiceId
                          ? () => router.push(`/invoices/${item.invoiceId}`)
                          : undefined
                      }
                    />
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

function PenaltyRiskCard({
  risk,
  onEstimate,
}: {
  risk: DashboardSummaryPenaltyRisk;
  onEstimate: () => void;
}) {
  const colors = useColors();
  // Card fill by risk. The matching *Foreground token flips to readable ink in
  // dark mode where these fills lighten — plain white failed AA there
  // (white-on-lightened-teal 2.51:1, white-on-amber 2.91:1).
  const bg =
    risk === "high"
      ? colors.destructive
      : risk === "medium"
        ? colors.warning
        : colors.primary;
  const fg =
    risk === "high"
      ? colors.destructiveForeground
      : risk === "medium"
        ? colors.warningForeground
        : colors.primaryForeground;
  const copy = RISK_COPY[risk] ?? RISK_COPY_FALLBACK;

  return (
    <Card style={{ backgroundColor: bg }}>
      <View style={styles.rowBetween}>
        <AppText variant="caption" color={fg}>
          PENALTY RISK
        </AppText>
        {/* Inverted chip: fill = foreground token, text = card fill. That pair
            is AA by construction, so the pill stays visible on all three
            colored cards — a tone-matched Badge vanished into the fill. */}
        <View style={[styles.riskBadge, { backgroundColor: fg }]}>
          <AppText variant="caption" color={bg}>
            {humanize(risk) || "Unknown"}
          </AppText>
        </View>
      </View>
      <AppText variant="heading" color={fg} style={{ marginTop: 10 }}>
        {copy}
      </AppText>
      <Pressable
        onPress={onEstimate}
        accessibilityRole="button"
        accessibilityLabel="Estimate my penalty exposure"
        style={({ pressed }) => [
          styles.riskLink,
          { opacity: pressed ? 0.7 : 1 },
        ]}
      >
        <AppText variant="label" color={fg}>
          Estimate my exposure
        </AppText>
        <Feather name="arrow-right" size={16} color={fg} />
      </Pressable>
    </Card>
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
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Next deadline: ${deadline.title}, due ${formatDate(
        deadline.dueDate,
      )}, ${countdownLabel(deadline.dueDate)}`}
    >
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

function ActivityRow({
  item,
  onPress,
}: {
  item: ActivityItem;
  onPress?: () => void;
}) {
  const colors = useColors();
  const failed = item.kind === "failed" || item.status === "failed";
  const content = (
    <View style={styles.activityRow}>
      <View
        style={[
          styles.dot,
          { backgroundColor: failed ? colors.destructive : colors.accent },
        ]}
      >
        <Feather
          name={failed ? "alert-triangle" : "file-text"}
          size={14}
          color={failed ? colors.destructiveForeground : colors.primary}
        />
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
      {onPress ? (
        <Feather name="chevron-right" size={16} color={colors.mutedForeground} />
      ) : null}
    </View>
  );

  if (!onPress) return content;
  const a11yLabel = [
    item.label,
    item.invoiceNumber,
    item.status ? humanize(item.status) : null,
    timeAgo(item.at),
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={a11yLabel}
      accessibilityHint="Opens invoice details"
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
      testID={`activity-item-${item.id}`}
    >
      {content}
    </Pressable>
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
  riskBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    alignSelf: "flex-start",
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
