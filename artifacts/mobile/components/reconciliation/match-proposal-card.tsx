import type { MatchProposalView } from "@workspace/api-client-react";
import { useRouter } from "expo-router";
import React from "react";
import { Pressable, View } from "react-native";

import {
  AppButton,
  AppText,
  Badge,
  Card,
  Divider,
  rowBetween,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { formatCurrency, formatDate, humanize } from "@/lib/format";
import {
  confidenceTone,
  percent,
  PROPOSAL_STATUS_LABEL,
  PROPOSAL_STATUS_TONE,
} from "@/lib/reconciliation";

/** One proposed match: the invoice link, the confidence, and Accept/Reject. */
export function MatchProposalCard({
  proposal: p,
  deciding,
  canDecide,
  acceptPending,
  rejectPending,
  onDecide,
}: {
  proposal: MatchProposalView;
  /** This proposal's decision is in flight. */
  deciding: boolean;
  canDecide: boolean;
  acceptPending: boolean;
  rejectPending: boolean;
  onDecide: (
    proposal: MatchProposalView,
    action: "accept" | "reject",
  ) => Promise<void>;
}) {
  const colors = useColors();
  const router = useRouter();
  return (
    <Card style={{ gap: 8 }}>
      <View style={rowBetween}>
        <Pressable
          onPress={() => router.push(`/invoices/${p.invoiceId}`)}
          accessibilityRole="link"
          accessibilityLabel={`Open invoice ${p.invoiceNumber}`}
          hitSlop={8}
        >
          <AppText variant="label" color={colors.primary}>
            {p.invoiceNumber}
          </AppText>
        </Pressable>
        <View style={{ flexDirection: "row", gap: 6 }}>
          <Badge
            label={`${percent(p.confidence)} match`}
            tone={confidenceTone(p.confidence)}
          />
          <Badge
            label={PROPOSAL_STATUS_LABEL[p.status] ?? humanize(p.status)}
            tone={PROPOSAL_STATUS_TONE[p.status] ?? "neutral"}
          />
        </View>
      </View>
      <AppText variant="caption" color={colors.mutedForeground}>
        {p.buyerName} · line {p.lineNo ?? "—"}
        {p.lineDate ? ` · ${formatDate(p.lineDate)}` : ""}
      </AppText>
      {p.narration ? (
        <AppText
          variant="caption"
          color={colors.mutedForeground}
          numberOfLines={2}
        >
          {p.narration}
        </AppText>
      ) : null}
      <Divider />
      <View style={rowBetween}>
        <View>
          <AppText variant="caption" color={colors.mutedForeground}>
            Bank credit
          </AppText>
          <AppText variant="label">{formatCurrency(p.lineAmount)}</AppText>
        </View>
        <View style={{ alignItems: "flex-end" }}>
          <AppText variant="caption" color={colors.mutedForeground}>
            Invoice total
          </AppText>
          <AppText variant="label">{formatCurrency(p.invoiceTotal)}</AppText>
        </View>
      </View>
      {p.status === "proposed" ? (
        canDecide ? (
          <View style={{ flexDirection: "row", gap: 10 }}>
            <View style={{ flex: 1 }}>
              <AppButton
                label="Accept"
                icon="check"
                onPress={() => void onDecide(p, "accept")}
                disabled={deciding}
                loading={deciding && acceptPending}
                testID={`button-accept-${p.id}`}
              />
            </View>
            <View style={{ flex: 1 }}>
              <AppButton
                label="Reject"
                icon="x"
                variant="secondary"
                onPress={() => void onDecide(p, "reject")}
                disabled={deciding}
                loading={deciding && rejectPending}
                testID={`button-reject-${p.id}`}
              />
            </View>
          </View>
        ) : (
          <AppText variant="caption" color={colors.mutedForeground}>
            Your accounting firm reviews and confirms matches.
          </AppText>
        )
      ) : null}
    </Card>
  );
}
