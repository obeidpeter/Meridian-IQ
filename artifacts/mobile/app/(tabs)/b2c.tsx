import { Feather } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetDashboardSummaryQueryKey,
  getListB2cReportItemsQueryKey,
  getListB2cReportsQueryKey,
  useListB2cReportItems,
  useListB2cReports,
  useSubmitB2cReport,
} from "@workspace/api-client-react";
import type { B2cReportBatch, B2cReportBatchStatus } from "@workspace/api-client-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  FlatList,
  RefreshControl,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
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
  EmptyState,
  ErrorState,
  Skeleton,
  webContentMax,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { hasStatus } from "@/lib/api-error";
import { formatCurrency, formatDateTime, humanize } from "@/lib/format";
import { useSession } from "@/lib/session";

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

const STATUS_TONE: Record<B2cReportBatchStatus, BadgeTone> = {
  open: "info",
  reported: "success",
  breached: "critical",
};

const STATUS_LABEL: Record<B2cReportBatchStatus, string> = {
  open: "Open",
  reported: "Reported",
  breached: "Breached",
};

// Re-render every 30s so deadline countdowns stay live without a refresh.
function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** The b2c_reporting flag being dark surfaces as a 404 from the API. */
const isFeatureUnavailable = (error: unknown): boolean => hasStatus(error, 404);

function countdown(deadlineAt: Date | string, now: number): {
  label: string;
  urgent: boolean;
} {
  const remaining = new Date(deadlineAt).getTime() - now;
  if (Number.isNaN(remaining)) return { label: "", urgent: false };
  if (remaining <= 0) return { label: "Deadline passed", urgent: true };
  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  return {
    label: `${hours}h ${String(minutes).padStart(2, "0")}m left to report`,
    urgent: remaining < FOUR_HOURS_MS,
  };
}

export default function B2cBatchesScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { clientPartyId } = useSession();
  const queryClient = useQueryClient();
  const now = useNow();

  const query = useListB2cReports(
    { clientPartyId: clientPartyId ?? "" },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getListB2cReportsQueryKey({
          clientPartyId: clientPartyId ?? "",
        }),
        retry: false,
      },
    },
  );

  const onRefresh = useCallback(() => {
    void query.refetch();
  }, [query]);

  const submit = useSubmitB2cReport();
  const [reportingId, setReportingId] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const markReported = useCallback(
    async (batch: B2cReportBatch) => {
      setReportingId(batch.id);
      setSubmitError(null);
      try {
        await submit.mutateAsync({ id: batch.id });
        // Not awaited: a background refetch rejection must not surface as a
        // false failure after the batch already filed.
        void queryClient.invalidateQueries({
          queryKey: getListB2cReportsQueryKey({
            clientPartyId: clientPartyId ?? "",
          }),
        });
        // The dashboard's at-risk / penalty counts derive from batch state, so
        // refresh it too now that this batch is reported.
        void queryClient.invalidateQueries({
          queryKey: getGetDashboardSummaryQueryKey({
            clientPartyId: clientPartyId ?? "",
          }),
        });
      } catch (e) {
        setSubmitError(
          e instanceof Error && e.message
            ? e.message
            : "Could not mark this batch reported. Please try again.",
        );
      } finally {
        setReportingId(null);
      }
    },
    [submit, queryClient, clientPartyId],
  );

  const batches = useMemo(
    () =>
      [...(query.data ?? [])].sort((a, b) =>
        String(b.windowStart).localeCompare(String(a.windowStart)),
      ),
    [query.data],
  );
  const openCount = batches.filter((b) => b.status === "open").length;
  const breachedCount = batches.filter(
    (b) => b.status === "breached" && !b.reportedAt,
  ).length;

  // M7: the 30s `useNow` tick keeps countdowns live, but the batch DATA never
  // refetched — so a window that just closed still showed an "Open" badge. When
  // a visible open batch's deadline has passed, invalidate the list so the
  // server reclassifies it (open → breached). The flag self-resets once the
  // refetched batch is no longer "open", so this fires once per closure rather
  // than looping.
  const hasClosedOpenBatch = useMemo(
    () =>
      batches.some(
        (b) => b.status === "open" && new Date(b.deadlineAt).getTime() <= now,
      ),
    [batches, now],
  );
  useEffect(() => {
    if (!hasClosedOpenBatch || !clientPartyId) return;
    void queryClient.invalidateQueries({
      queryKey: getListB2cReportsQueryKey({ clientPartyId }),
    });
  }, [hasClosedOpenBatch, clientPartyId, queryClient]);

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
  const caption = (
    <AppText
      variant="caption"
      color={colors.mutedForeground}
      style={{ marginBottom: 12 }}
    >
      Consumer sales are batched into 24-hour windows — report each batch before
      its window closes.
    </AppText>
  );

  if (query.isLoading) {
    return (
      <ScrollView
        style={{ backgroundColor: colors.background }}
        contentContainerStyle={contentContainerStyle}
        showsVerticalScrollIndicator={false}
        refreshControl={refreshControl}
      >
        {caption}
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
        {caption}
        {isFeatureUnavailable(query.error) ? (
          <EmptyState
            icon="lock"
            title="B2C reporting isn't available"
            message="This feature isn't enabled for your firm yet."
          />
        ) : (
          <ErrorState
            message="We couldn't load your B2C reporting batches."
            onRetry={onRefresh}
          />
        )}
      </ScrollView>
    );
  }

  if (batches.length === 0) {
    return (
      <ScrollView
        style={{ backgroundColor: colors.background }}
        contentContainerStyle={contentContainerStyle}
        showsVerticalScrollIndicator={false}
        refreshControl={refreshControl}
      >
        {caption}
        <EmptyState
          icon="shopping-bag"
          title="No B2C batches yet"
          message="Stamp a consumer (B2C) invoice and a reporting batch opens automatically."
        />
      </ScrollView>
    );
  }

  const listHeader = (
    <View style={{ gap: 20, marginBottom: 20 }}>
      {caption}
      {openCount > 0 || breachedCount > 0 ? (
        <View style={{ flexDirection: "row", gap: 12 }}>
          {openCount > 0 ? (
            <Card style={{ flex: 1 }}>
              <AppText variant="title">{openCount}</AppText>
              <AppText variant="label" color={colors.mutedForeground}>
                Open
              </AppText>
            </Card>
          ) : null}
          {breachedCount > 0 ? (
            <Card style={{ flex: 1, backgroundColor: colors.destructive }}>
              <AppText variant="title" color={colors.destructiveForeground}>
                {breachedCount}
              </AppText>
              <AppText variant="label" color={colors.destructiveForeground}>
                Breached
              </AppText>
            </Card>
          ) : null}
        </View>
      ) : null}
      {submitError ? (
        <Card>
          <AppText variant="caption" color={colors.destructiveText}>
            {submitError}
          </AppText>
        </Card>
      ) : null}
    </View>
  );

  // FlatList virtualizes the batches so they aren't all mounted at once.
  return (
    <FlatList
      style={{ backgroundColor: colors.background }}
      data={batches}
      keyExtractor={(batch) => batch.id}
      renderItem={({ item }) => (
        <BatchCard
          batch={item}
          now={now}
          reporting={reportingId === item.id}
          onMarkReported={() => void markReported(item)}
        />
      )}
      ListHeaderComponent={listHeader}
      ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
      showsVerticalScrollIndicator={false}
      contentContainerStyle={contentContainerStyle}
      refreshControl={refreshControl}
    />
  );
}

function BatchCard({
  batch,
  now,
  reporting,
  onMarkReported,
}: {
  batch: B2cReportBatch;
  now: number;
  reporting: boolean;
  onMarkReported: () => void;
}) {
  const colors = useColors();
  const [expanded, setExpanded] = useState(false);
  const needsReport =
    batch.status === "open" || (batch.status === "breached" && !batch.reportedAt);
  const timer = countdown(batch.deadlineAt, now);

  return (
    <Card>
      <View style={{ gap: 10 }}>
        <View style={styles.cardHeader}>
          <View style={{ flex: 1, gap: 4 }}>
            <AppText variant="label">
              Window from {formatDateTime(batch.windowStart)}
            </AppText>
            <AppText variant="caption" color={colors.mutedForeground}>
              {batch.itemCount} sale{batch.itemCount === 1 ? "" : "s"} ·{" "}
              {formatCurrency(batch.totalAmount)}
            </AppText>
            <AppText variant="caption" color={colors.mutedForeground}>
              Window closes {formatDateTime(batch.deadlineAt)}
            </AppText>
          </View>
          <Badge
            label={STATUS_LABEL[batch.status] ?? humanize(batch.status)}
            tone={STATUS_TONE[batch.status] ?? "neutral"}
          />
        </View>

        {batch.status === "open" ? (
          <View style={styles.inlineRow}>
            <Feather
              name="clock"
              size={14}
              color={timer.urgent ? colors.destructiveText : colors.mutedForeground}
            />
            <AppText
              variant="caption"
              color={timer.urgent ? colors.destructiveText : colors.mutedForeground}
            >
              {timer.label}
            </AppText>
          </View>
        ) : null}

        {batch.reportedAt ? (
          <View style={styles.inlineRow}>
            <Feather name="check-circle" size={14} color={colors.primary} />
            <AppText variant="caption" color={colors.mutedForeground}>
              Reported {formatDateTime(batch.reportedAt)}
            </AppText>
          </View>
        ) : batch.status === "breached" ? (
          <View style={styles.inlineRow}>
            <Feather name="alert-triangle" size={14} color={colors.destructiveText} />
            <AppText variant="caption" color={colors.destructiveText}>
              Deadline missed — report now
            </AppText>
          </View>
        ) : null}

        {needsReport ? (
          <AppButton
            label={reporting ? "Reporting…" : "Mark reported"}
            onPress={onMarkReported}
            loading={reporting}
            fullWidth={false}
          />
        ) : null}

        <TouchableOpacity
          onPress={() => setExpanded((v) => !v)}
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          accessibilityLabel={
            expanded
              ? "Hide batch items"
              : `View ${batch.itemCount} batch item${batch.itemCount === 1 ? "" : "s"}`
          }
          style={styles.inlineRow}
        >
          <Feather
            name={expanded ? "chevron-up" : "chevron-down"}
            size={16}
            color={colors.primary}
          />
          <AppText variant="caption" color={colors.primary}>
            {expanded ? "Hide items" : `View items (${batch.itemCount})`}
          </AppText>
        </TouchableOpacity>

        {expanded ? <BatchItems batchId={batch.id} /> : null}
      </View>
    </Card>
  );
}

function BatchItems({ batchId }: { batchId: string }) {
  const colors = useColors();
  const query = useListB2cReportItems(batchId, {
    query: {
      enabled: !!batchId,
      queryKey: getListB2cReportItemsQueryKey(batchId),
      retry: false,
    },
  });

  if (query.isLoading) {
    return (
      <View style={{ gap: 8 }}>
        <Skeleton height={36} />
        <Skeleton height={36} />
      </View>
    );
  }

  if (query.isError) {
    return (
      <AppText variant="caption" color={colors.destructiveText}>
        Unable to load this batch&apos;s items.
      </AppText>
    );
  }

  const items = query.data ?? [];
  if (items.length === 0) {
    return (
      <AppText variant="caption" color={colors.mutedForeground}>
        No items in this batch yet.
      </AppText>
    );
  }

  return (
    <View>
      {items.map((item, index) => (
        <View key={item.id}>
          {index > 0 ? <Divider /> : null}
          <View style={styles.itemRow}>
            <View style={{ flex: 1, gap: 2 }}>
              <AppText variant="caption">
                Invoice {item.invoiceId.slice(0, 8)}…
              </AppText>
              <AppText variant="caption" color={colors.mutedForeground}>
                Added {formatDateTime(item.createdAt)}
              </AppText>
            </View>
            <AppText variant="label">{formatCurrency(item.amount)}</AppText>
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: 20,
    paddingTop: 12,
    ...webContentMax,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  inlineRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 8,
  },
});
