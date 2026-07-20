import { Feather } from "@expo/vector-icons";
import {
  getGetClerkDigestQueryKey,
  getListClientStatementsQueryKey,
  useGetClerkDigest,
  useListClientStatements,
} from "@workspace/api-client-react";
import type {
  ClerkClientStatement,
  ClerkDigest,
} from "@workspace/api-client-react";
import { Stack } from "expo-router";
import React, { useState } from "react";
import { Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  AppText,
  Banner,
  Card,
  CardSkeleton,
  Divider,
  EmptyState,
  ErrorState,
  rowBetween,
  ScreenScroll,
  stackHeaderOptions,
  webContentMax,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { isFeatureUnavailable } from "@/lib/api-error";
import {
  digestSourceNote,
  statementMonthLabel,
  updatesAudience,
} from "@/lib/clerk-updates";
import { formatDate } from "@/lib/format";
import { useSession } from "@/lib/session";

// "Digests & statements": the sweep-generated Clerk narratives, read-only —
// this screen only ever reads what the server already generated, so it never
// spends tokens. Firm staff see the firm's weekly digest; a client_user sees
// their own monthly statements. The two audiences hit DIFFERENT endpoints:
// GET /clerk/digest refuses client_user by role (its facts span the whole
// client book — SEC-03), so the role branch in lib/clerk-updates decides
// which query runs and the refused call is never made.

export default function ClerkUpdatesScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { me, clientPartyId } = useSession();
  const audience = updatesAudience(me?.role, me?.capabilities);

  // Both hooks mount unconditionally (rules of hooks); `enabled` picks the
  // one this principal may call.
  const digestQuery = useGetClerkDigest({
    query: {
      enabled: audience === "firm",
      queryKey: getGetClerkDigestQueryKey(),
      // 404 is a final answer ("no digest generated yet"), not transient.
      retry: false,
    },
  });
  const statementsQuery = useListClientStatements(
    { clientPartyId: clientPartyId ?? "" },
    {
      query: {
        enabled: audience === "client" && !!clientPartyId,
        queryKey: getListClientStatementsQueryKey({
          clientPartyId: clientPartyId ?? "",
        }),
        retry: false,
      },
    },
  );

  const refreshing =
    audience === "firm"
      ? digestQuery.isRefetching
      : audience === "client"
        ? statementsQuery.isRefetching
        : false;
  const onRefresh = () => {
    if (audience === "firm") void digestQuery.refetch();
    if (audience === "client") void statementsQuery.refetch();
  };

  return (
    <>
      <Stack.Screen
        options={stackHeaderOptions(colors, "Digests & statements")}
      />
      <ScreenScroll
        contentContainerStyle={[
          styles.content,
          { paddingBottom: insets.bottom + 48 },
        ]}
        refreshControl={
          audience ? (
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.primary}
            />
          ) : undefined
        }
      >
        {!audience ? (
          <EmptyState
            icon="lock"
            title="Updates aren't available on your account"
            message="Ask your accounting firm to enable Clerk updates for you."
          />
        ) : audience === "firm" ? (
          digestQuery.isLoading ? (
            <CardSkeleton lines={4} />
          ) : digestQuery.isError ? (
            isFeatureUnavailable(digestQuery.error) ? (
              // 404: the weekly sweep hasn't produced one yet (the digest
              // feature is opt-in per deployment).
              <EmptyState
                icon="inbox"
                title="No digest yet"
                message="Your firm's weekly digest appears here once the weekly summary has been generated."
              />
            ) : (
              <ErrorState
                message="We couldn't load your firm's digest."
                onRetry={() => void digestQuery.refetch()}
              />
            )
          ) : digestQuery.data ? (
            <DigestCard digest={digestQuery.data} />
          ) : null
        ) : (
          <ClientStatementList
            statements={statementsQuery.data ?? []}
            isLoading={statementsQuery.isLoading}
            isError={statementsQuery.isError}
            onRetry={() => void statementsQuery.refetch()}
          />
        )}
      </ScreenScroll>
    </>
  );
}

/** One "• text" line, shared by the digest card and statement rows. */
function BulletRow({ text }: { text: string }) {
  const colors = useColors();
  return (
    <View style={styles.bulletRow}>
      <AppText variant="body" color={colors.mutedForeground}>
        {"•"}
      </AppText>
      <AppText variant="body" style={{ flex: 1 }}>
        {text}
      </AppText>
    </View>
  );
}

function DigestCard({ digest }: { digest: ClerkDigest }) {
  const colors = useColors();
  return (
    <View style={{ gap: 20 }}>
      <Banner
        tone="info"
        message="Every fact is computed from your firm's records — Clerk only phrases them."
      />
      <Card style={{ gap: 12 }}>
        <AppText variant="overline" color={colors.mutedForeground}>
          Weekly digest
        </AppText>
        <AppText variant="heading">{digest.headline}</AppText>
        {digest.bullets.length > 0 ? (
          <>
            <Divider />
            <View style={{ gap: 8 }}>
              {digest.bullets.map((bullet, i) => (
                <BulletRow key={i} text={bullet} />
              ))}
            </View>
          </>
        ) : null}
        <AppText variant="caption" color={colors.mutedForeground}>
          Week of {formatDate(digest.weekStart)} ·{" "}
          {digestSourceNote(digest.source)}
        </AppText>
      </Card>
    </View>
  );
}

function ClientStatementList({
  statements,
  isLoading,
  isError,
  onRetry,
}: {
  statements: ClerkClientStatement[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
}) {
  const colors = useColors();
  // Expansion keyed by monthStart — unique per statement for one client
  // (the table is unique on firm+client+month).
  const [expandedMonth, setExpandedMonth] = useState<string | null>(null);

  if (isLoading) {
    return (
      <View style={{ gap: 12 }}>
        <CardSkeleton lines={2} />
        <CardSkeleton lines={2} />
      </View>
    );
  }
  if (isError) {
    return (
      <ErrorState
        message="We couldn't load your monthly statements."
        onRetry={onRetry}
      />
    );
  }
  if (statements.length === 0) {
    return (
      <EmptyState
        icon="inbox"
        title="No statements yet"
        message="Your monthly compliance statement appears here once a full month has closed."
      />
    );
  }
  return (
    <View style={{ gap: 12 }}>
      <AppText variant="body" color={colors.mutedForeground}>
        A summary of each closed month, generated from your own records.
      </AppText>
      {statements.map((statement) => (
        <StatementRow
          key={statement.monthStart}
          statement={statement}
          expanded={expandedMonth === statement.monthStart}
          onToggle={() =>
            setExpandedMonth((prev) =>
              prev === statement.monthStart ? null : statement.monthStart,
            )
          }
        />
      ))}
    </View>
  );
}

function StatementRow({
  statement,
  expanded,
  onToggle,
}: {
  statement: ClerkClientStatement;
  expanded: boolean;
  onToggle: () => void;
}) {
  const colors = useColors();
  const monthLabel = statementMonthLabel(statement.monthStart);
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      accessibilityLabel={`${monthLabel}: ${statement.headline}`}
      accessibilityHint="Shows the month's detail"
      testID={`statement-${statement.monthStart}`}
    >
      <Card style={{ gap: 10 }}>
        <View style={rowBetween}>
          <AppText variant="overline" color={colors.mutedForeground}>
            {monthLabel}
          </AppText>
          <Feather
            name={expanded ? "chevron-up" : "chevron-down"}
            size={16}
            color={colors.mutedForeground}
          />
        </View>
        <AppText variant="label">{statement.headline}</AppText>
        {expanded ? (
          <>
            <Divider />
            {statement.bullets.length > 0 ? (
              <View style={{ gap: 8 }}>
                {statement.bullets.map((bullet, i) => (
                  <BulletRow key={i} text={bullet} />
                ))}
              </View>
            ) : null}
            <AppText variant="caption" color={colors.mutedForeground}>
              {digestSourceNote(statement.source)}
            </AppText>
          </>
        ) : null}
      </Card>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: 20,
    paddingTop: 16,
    ...webContentMax,
  },
  bulletRow: {
    flexDirection: "row",
    gap: 8,
  },
});
