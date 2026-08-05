import { Feather } from "@expo/vector-icons";
import {
  getGetMonthEndCloseQueryKey,
  useGetMonthEndClose,
} from "@workspace/api-client-react";
import type { MonthEndCloseItemsItem } from "@workspace/api-client-react";
import { Stack, useRouter } from "expo-router";
import React, { useCallback } from "react";
import { Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  AppText,
  Badge,
  Card,
  CardSkeleton,
  Divider,
  EmptyState,
  ErrorState,
  rowBetween,
  screenContent,
  ScreenScroll,
  stackHeaderOptions,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { formatDate } from "@/lib/format";
import { closeHeaderPill, closeItemRoute, closeItemTitle } from "@/lib/month-end";
import { useSession } from "@/lib/session";

function CloseItemRow({
  item,
  onOpen,
}: {
  item: MonthEndCloseItemsItem;
  /** Set only for items whose detail lives on a screen this app has. */
  onOpen: (() => void) | null;
}) {
  const colors = useColors();
  const attention = item.status === "attention";
  const a11yLabel = [
    closeItemTitle(item),
    attention ? "needs review" : "clear",
    attention ? item.detail : null,
  ]
    .filter(Boolean)
    .join(", ");

  const content = (
    <View style={styles.itemRow}>
      <Feather
        name={attention ? "alert-triangle" : "check-circle"}
        size={16}
        color={attention ? colors.warning : colors.success}
        style={{ marginTop: 2 }}
      />
      <View style={{ flex: 1, gap: 2 }}>
        <AppText
          variant={attention ? "label" : "body"}
          color={attention ? colors.foreground : colors.mutedForeground}
        >
          {closeItemTitle(item)}
        </AppText>
        {/* The detail carries the server's own saturation hedge ("Showing
            the detector's top N — more may exist"), so a capped count never
            reads as the whole backlog. */}
        {attention ? (
          <AppText variant="caption" color={colors.mutedForeground}>
            {item.detail}
          </AppText>
        ) : null}
      </View>
      {onOpen ? (
        <Feather
          name="chevron-right"
          size={16}
          color={colors.mutedForeground}
          style={{ marginTop: 2 }}
        />
      ) : null}
    </View>
  );

  if (!onOpen) {
    return (
      <View accessible accessibilityLabel={a11yLabel} testID={`close-item-${item.key}`}>
        {content}
      </View>
    );
  }
  return (
    <Pressable
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={a11yLabel}
      accessibilityHint="Opens the screen where this is worked"
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
      testID={`close-item-${item.key}`}
    >
      {content}
    </Pressable>
  );
}

export default function MonthEndScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { clientPartyId } = useSession();

  const query = useGetMonthEndClose(
    { clientPartyId: clientPartyId ?? "" },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getGetMonthEndCloseQueryKey({
          clientPartyId: clientPartyId ?? "",
        }),
        // The checklist composes seven detector queries server-side — don't
        // re-run the sweep on every focus (the web card's staleTime).
        staleTime: 5 * 60_000,
        retry: false,
      },
    },
  );
  const close = query.data;

  const onRefresh = useCallback(() => {
    void query.refetch();
  }, [query]);

  const pill = close ? closeHeaderPill(close.attentionCount) : null;

  return (
    <>
      <Stack.Screen options={stackHeaderOptions(colors, "Month-end close")} />
      <ScreenScroll
        contentContainerStyle={[
          screenContent,
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
        {query.isLoading ? (
          <View style={{ gap: 12 }}>
            <CardSkeleton lines={3} />
            <CardSkeleton lines={3} />
          </View>
        ) : query.isError ? (
          <ErrorState
            message="We couldn't load the month-end checklist."
            onRetry={onRefresh}
          />
        ) : !close || close.items.length === 0 ? (
          <EmptyState
            icon="check-circle"
            title="Nothing to review"
            message="The month-end checklist will appear here once there is activity to check."
          />
        ) : (
          <View style={{ gap: 12 }}>
            <AppText variant="body" color={colors.mutedForeground}>
              The platform&apos;s advisories composed into one checklist —
              review each item before closing the month. Advisory only; a
              human closes the month.
            </AppText>

            <Card style={{ gap: 4 }}>
              <View style={rowBetween}>
                <AppText variant="overline" color={colors.mutedForeground}>
                  As of {formatDate(close.asOf)}
                </AppText>
                {pill ? (
                  <View
                    testID={
                      close.attentionCount > 0
                        ? "text-close-attention-count"
                        : "text-close-all-clear"
                    }
                  >
                    <Badge label={pill.label} tone={pill.tone} />
                  </View>
                ) : null}
              </View>
              <View style={{ marginTop: 6 }}>
                {close.items.map((item, index) => {
                  const route = closeItemRoute(item.key);
                  return (
                    <View key={item.key}>
                      {index > 0 ? <Divider /> : null}
                      <CloseItemRow
                        item={item}
                        onOpen={route ? () => router.push(route) : null}
                      />
                    </View>
                  );
                })}
              </View>
            </Card>

            <AppText variant="caption" color={colors.mutedForeground}>
              {close.note}
            </AppText>
          </View>
        )}
      </ScreenScroll>
    </>
  );
}

const styles = StyleSheet.create({
  itemRow: {
    flexDirection: "row",
    gap: 10,
    paddingVertical: 8,
  },
});
