import { Feather } from "@expo/vector-icons";
import {
  DashboardSummaryPenaltyRisk,
  getGetDashboardSummaryQueryKey,
  getGetReceivablesSummaryQueryKey,
  useGetDashboardSummary,
  useGetReceivablesSummary,
} from "@workspace/api-client-react";
import type {
  ActivityItem,
  ComplianceDeadline,
  ReceivablesBucket,
  ReceivablesSummary,
} from "@workspace/api-client-react";
import { useRouter } from "expo-router";
import React, { useCallback } from "react";
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  ActionTile,
  AppButton,
  AppText,
  Card,
  CardSkeleton,
  Divider,
  ErrorState,
  rowBetween,
  Skeleton,
  StatTile,
  webContentMax,
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

  // Receivables aging is a separate endpoint so its card degrades on its own —
  // a failure here never blanks the rest of the dashboard.
  const receivablesQuery = useGetReceivablesSummary(
    { clientPartyId: clientPartyId ?? "" },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getGetReceivablesSummaryQueryKey({
          clientPartyId: clientPartyId ?? "",
        }),
      },
    },
  );

  const onRefresh = useCallback(() => {
    void query.refetch();
    void receivablesQuery.refetch();
  }, [query, receivablesQuery]);

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
        <AppText variant="overline" color={colors.mutedForeground}>
          {greeting()}
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
              icon="file-minus"
              tone={summary.unsubmittedCount > 0 ? colors.warning : undefined}
            />
            <StatTile
              label="At risk"
              value={String(summary.atRiskCount)}
              icon="alert-triangle"
              tone={summary.atRiskCount > 0 ? colors.destructiveText : undefined}
            />
          </View>
          <View style={{ flexDirection: "row", gap: 12 }}>
            <StatTile
              label="Stamped"
              value={String(summary.stampedCount)}
              icon="check-circle"
              tone={summary.stampedCount > 0 ? colors.success : undefined}
            />
            <StatTile
              label="Unsubmitted value"
              value={formatCurrency(summary.unsubmittedValue)}
              icon="trending-up"
            />
          </View>

          <ReceivablesCard
            summary={receivablesQuery.data}
            isLoading={receivablesQuery.isLoading}
            isError={receivablesQuery.isError}
            onRetry={() => void receivablesQuery.refetch()}
          />

          {summary.nextDeadline ? (
            <NextDeadlineCard
              deadline={summary.nextDeadline}
              onPress={() => router.push("/deadlines")}
            />
          ) : null}

          <View style={{ gap: 12 }}>
            <AppText variant="heading">Quick actions</AppText>
            {/* A 2×2 launcher grid: four stacked full-width buttons read as a
                wall of chrome; icon tiles are scannable at a glance. */}
            <View style={styles.actionGrid}>
              <ActionTile
                label="Create an invoice"
                icon="file-plus"
                primary
                onPress={() => router.push("/invoice")}
                testID="action-create-invoice"
              />
              <ActionTile
                label="Browse invoices"
                icon="file-text"
                onPress={() => router.push("/invoices")}
                testID="action-browse-invoices"
              />
              <ActionTile
                label="Reconcile payments"
                icon="credit-card"
                onPress={() => router.push("/reconciliation")}
                testID="action-reconcile"
              />
              <ActionTile
                label="Penalty estimator"
                icon="trending-up"
                onPress={() => router.push("/estimator")}
                testID="action-estimator"
              />
            </View>
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
                    {/* Inset past the 32px icon dot so the rule aligns with
                        the text column (14 padding + 32 dot + 12 gap). */}
                    {index > 0 ? <Divider inset={58} /> : null}
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
  const watermark: React.ComponentProps<typeof Feather>["name"] =
    risk === "high" ? "alert-triangle" : risk === "medium" ? "alert-circle" : "shield";
  const copy = RISK_COPY[risk] ?? RISK_COPY_FALLBACK;

  return (
    <Card style={{ backgroundColor: bg }}>
      {/* Decorative watermark, clipped by an inner overlay (clipping the Card
          itself would also clip its drop shadow). Pointer-transparent so the
          estimate link stays tappable. */}
      <View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          { borderRadius: colors.radius, overflow: "hidden" },
        ]}
      >
        <Feather
          name={watermark}
          size={104}
          color={fg}
          style={styles.riskWatermark}
        />
      </View>
      <View style={styles.rowBetween}>
        <AppText variant="overline" color={fg}>
          Penalty risk
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

function AgingBucketTile({
  label,
  bucket,
  tone,
}: {
  label: string;
  bucket: ReceivablesBucket;
  tone?: "warning" | "danger";
}) {
  const colors = useColors();
  // The late buckets only take their warning/danger tint once something is
  // actually sitting in them. destructiveText is the red tuned for text on
  // cards in both schemes; warning carries enough contrast as-is.
  const nonZero = bucket.count > 0 || Number(bucket.amount) > 0;
  const valueColor =
    nonZero && tone === "danger"
      ? colors.destructiveText
      : nonZero && tone === "warning"
        ? colors.warning
        : colors.foreground;
  return (
    <View
      accessible
      accessibilityLabel={`${label}: ${formatCurrency(bucket.amount)} across ${
        bucket.count
      } invoice${bucket.count === 1 ? "" : "s"}`}
      style={[
        styles.bucketTile,
        { backgroundColor: colors.secondary, borderRadius: colors.radius },
      ]}
    >
      <AppText variant="caption" color={colors.mutedForeground}>
        {label}
      </AppText>
      <AppText variant="label" color={valueColor} style={{ marginTop: 2 }}>
        {formatCurrency(bucket.amount)}
      </AppText>
      <AppText variant="caption" color={colors.mutedForeground}>
        {bucket.count} invoice{bucket.count === 1 ? "" : "s"}
      </AppText>
    </View>
  );
}

function ReceivablesCard({
  summary,
  isLoading,
  isError,
  onRetry,
}: {
  summary: ReceivablesSummary | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
}) {
  const colors = useColors();
  const primary =
    summary && summary.groups.length > 0 ? summary.groups[0] : undefined;
  const extraGroups = summary ? summary.groups.length - 1 : 0;

  return (
    <Card>
      <AppText variant="overline" color={colors.mutedForeground}>
        Receivables
      </AppText>
      {isLoading ? (
        <View style={{ gap: 8, marginTop: 10 }}>
          <Skeleton height={24} width="45%" />
          <Skeleton height={12} width="70%" />
          <Skeleton height={48} />
        </View>
      ) : isError ? (
        <View style={{ marginTop: 10, gap: 10 }}>
          <AppText variant="body" color={colors.mutedForeground}>
            We couldn&apos;t load your receivables.
          </AppText>
          <AppButton
            label="Try again"
            icon="refresh-cw"
            variant="secondary"
            fullWidth={false}
            onPress={onRetry}
          />
        </View>
      ) : !primary ? (
        <AppText
          variant="body"
          color={colors.mutedForeground}
          style={{ marginTop: 10 }}
        >
          No outstanding receivables.
        </AppText>
      ) : (
        <>
          <AppText variant="title" style={{ marginTop: 8 }}>
            {formatCurrency(primary.outstandingTotal)}
          </AppText>
          <AppText
            variant="caption"
            color={colors.mutedForeground}
            style={{ marginTop: 2 }}
          >
            Outstanding across {primary.invoiceCount} invoice
            {primary.invoiceCount === 1 ? "" : "s"}
            {extraGroups > 0
              ? ` · +${extraGroups} more ${
                  extraGroups === 1 ? "currency" : "currencies"
                }`
              : ""}
          </AppText>
          <View style={styles.bucketGrid}>
            <AgingBucketTile
              label="Current (≤30d)"
              bucket={primary.buckets.current}
            />
            <AgingBucketTile
              label="31–60 days"
              bucket={primary.buckets.days31to60}
            />
            <AgingBucketTile
              label="61–90 days"
              bucket={primary.buckets.days61to90}
              tone="warning"
            />
            <AgingBucketTile
              label="90+ days"
              bucket={primary.buckets.days90plus}
              tone="danger"
            />
          </View>
        </>
      )}
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
          <AppText variant="overline" color={colors.mutedForeground}>
            Next deadline
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
    ...webContentMax,
  },
  rowBetween: { ...rowBetween },
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
  riskWatermark: {
    position: "absolute",
    right: -16,
    bottom: -22,
    opacity: 0.14,
  },
  actionGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
  },
  bucketGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 12,
  },
  bucketTile: {
    flexGrow: 1,
    flexBasis: "45%",
    padding: 10,
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
