import {
  getListObligationsQueryKey,
  useListObligations,
} from "@workspace/api-client-react";
import type { Obligation } from "@workspace/api-client-react";
import { Stack } from "expo-router";
import React, { useCallback } from "react";
import { RefreshControl, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  AppText,
  Badge,
  Card,
  CardSkeleton,
  EmptyState,
  ErrorState,
  rowBetween,
  ScreenScroll,
  stackHeaderOptions,
  webContentMax,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { formatDate } from "@/lib/format";
import {
  authorityLabel,
  localDayIso,
  noticeTypeLabel,
  obligationBadge,
  obligationLine,
} from "@/lib/obligations";
import { useSession } from "@/lib/session";

// Read-only by design: obligations are recorded and dispositioned by the
// accounting firm when it approves a captured notice — this screen only
// watches the record and its response deadlines. No clientPartyId is passed:
// the server pins a client_user to its own party (and orders the list
// soonest deadline first, so no client-side sort).

function ObligationRow({
  obligation,
  todayIso,
}: {
  obligation: Obligation;
  todayIso: string;
}) {
  const colors = useColors();
  const badge = obligationBadge(
    obligation.status,
    obligation.responseDueDate,
    todayIso,
  );
  const detail = obligationLine(obligation);
  const a11yLabel = [
    noticeTypeLabel(obligation.noticeType),
    authorityLabel(obligation.authority),
    detail || null,
    `respond by ${formatDate(obligation.responseDueDate)}`,
    badge.label,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <View accessible accessibilityLabel={a11yLabel} testID={`obligation-${obligation.id}`}>
      <Card style={{ gap: 6 }}>
        <View style={rowBetween}>
          <AppText
            variant="label"
            numberOfLines={1}
            style={{ flex: 1, marginRight: 8 }}
          >
            {noticeTypeLabel(obligation.noticeType)}
          </AppText>
          <Badge label={badge.label} tone={badge.tone} />
        </View>
        <AppText variant="caption" color={colors.mutedForeground}>
          {authorityLabel(obligation.authority)}
          {detail ? ` · ${detail}` : ""}
        </AppText>
        <AppText
          variant="caption"
          color={
            badge.label === "Overdue"
              ? colors.destructiveText
              : badge.label === "Due soon"
                ? colors.warning
                : colors.mutedForeground
          }
        >
          Respond by {formatDate(obligation.responseDueDate)}
        </AppText>
      </Card>
    </View>
  );
}

export default function ObligationsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { me } = useSession();
  const canRead = !!me?.capabilities?.includes("obligation.read");

  const query = useListObligations(undefined, {
    query: {
      enabled: canRead,
      queryKey: getListObligationsQueryKey(),
      retry: false,
    },
  });
  const obligations = query.data?.obligations ?? [];
  const todayIso = localDayIso(new Date());

  const onRefresh = useCallback(() => {
    void query.refetch();
  }, [query]);

  return (
    <>
      <Stack.Screen options={stackHeaderOptions(colors, "Obligations")} />
      <ScreenScroll
        contentContainerStyle={[
          styles.content,
          { paddingBottom: insets.bottom + 48 },
        ]}
        refreshControl={
          <RefreshControl
            refreshing={query.isRefetching}
            onRefresh={onRefresh}
            tintColor={colors.primary}
          />
        }
      >
        {!canRead ? (
          <EmptyState
            icon="lock"
            title="Obligations aren't available on your account"
            message="Ask your accounting firm to enable obligation tracking for you."
          />
        ) : query.isLoading ? (
          <View style={{ gap: 12 }}>
            <CardSkeleton lines={2} />
            <CardSkeleton lines={2} />
            <CardSkeleton lines={2} />
          </View>
        ) : query.isError ? (
          <ErrorState
            message="We couldn't load your obligations."
            onRetry={onRefresh}
          />
        ) : obligations.length === 0 ? (
          <EmptyState
            icon="inbox"
            title="No obligations recorded"
            message="When your accountant approves a captured tax-authority notice, it appears here with its response deadline."
          />
        ) : (
          <View style={{ gap: 12 }}>
            <AppText variant="body" color={colors.mutedForeground}>
              Tax-authority notices your firm has recorded, soonest response
              deadline first. Your accountant updates each one as it is
              responded to and closed.
            </AppText>
            {obligations.map((obligation) => (
              <ObligationRow
                key={obligation.id}
                obligation={obligation}
                todayIso={todayIso}
              />
            ))}
          </View>
        )}
      </ScreenScroll>
    </>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: 20,
    paddingTop: 16,
    ...webContentMax,
  },
});
