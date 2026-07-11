import { Feather } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListB2cReportItemsQueryKey,
  getListB2cReportsQueryKey,
  useListB2cReportItems,
  useListB2cReports,
  useSubmitB2cReport,
} from "@workspace/api-client-react";
import type { B2cReportBatch, B2cReportBatchStatus } from "@workspace/api-client-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Platform,
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
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { formatCurrency, formatDateTime } from "@/lib/format";
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
function isFeatureUnavailable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status?: unknown }).status === 404
  );
}

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
      <AppText
        variant="caption"
        color={colors.mutedForeground}
        style={{ marginBottom: 12 }}
      >
        Consumer sales are batched into 24-hour windows — report each batch
        before its window closes.
      </AppText>

      {query.isLoading ? (
        <View style={{ gap: 12 }}>
          <CardSkeleton lines={2} />
          <CardSkeleton lines={2} />
          <CardSkeleton lines={2} />
        </View>
      ) : query.isError ? (
        isFeatureUnavailable(query.error) ? (
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
        )
      ) : batches.length === 0 ? (
        <EmptyState
          icon="shopping-bag"
          title="No B2C batches yet"
          message="Stamp a consumer (B2C) invoice and a reporting batch opens automatically."
        />
      ) : (
        <View style={{ gap: 20 }}>
          {(openCount > 0 || breachedCount > 0) && (
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
                  <AppText variant="title" color="#ffffff">
                    {breachedCount}
                  </AppText>
                  <AppText variant="label" color="#ffffff">
                    Breached
                  </AppText>
                </Card>
              ) : null}
            </View>
          )}

          {submitError ? (
            <Card>
              <AppText variant="caption" color={colors.destructive}>
                {submitError}
              </AppText>
            </Card>
          ) : null}

          <View style={{ gap: 12 }}>
            {batches.map((batch) => (
              <BatchCard
                key={batch.id}
                batch={batch}
                now={now}
                reporting={reportingId === batch.id}
                onMarkReported={() => void markReported(batch)}
              />
            ))}
          </View>
        </View>
      )}
    </ScrollView>
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
          <Badge label={STATUS_LABEL[batch.status]} tone={STATUS_TONE[batch.status]} />
        </View>

        {batch.status === "open" ? (
          <View style={styles.inlineRow}>
            <Feather
              name="clock"
              size={14}
              color={timer.urgent ? colors.destructive : colors.mutedForeground}
            />
            <AppText
              variant="caption"
              color={timer.urgent ? colors.destructive : colors.mutedForeground}
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
            <Feather name="alert-triangle" size={14} color={colors.destructive} />
            <AppText variant="caption" color={colors.destructive}>
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
      <AppText variant="caption" color={colors.destructive}>
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
    ...(Platform.OS === "web"
      ? { maxWidth: 640, alignSelf: "center", width: "100%" }
      : {}),
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
