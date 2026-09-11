import { Feather } from "@expo/vector-icons";
import React from "react";
import { StyleSheet, View } from "react-native";

import {
  AppButton,
  AppText,
  Banner,
  Card,
  CardSkeleton,
  TextField,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import type { PartyDraft } from "@/lib/fix-invoice";

/**
 * One party's editable registration details on the fix screen, or the
 * reason they can't be edited here: locked (managed by the firm) or a
 * transient load failure with a retry.
 */
export function PartySection({
  title,
  subtitle,
  draft,
  onChange,
  highlighted,
  locked,
  lockedMessage,
  loadFailed = false,
  loadFailedMessage,
  onRetry,
}: {
  title: string;
  subtitle?: string;
  draft: PartyDraft | null;
  onChange: (patch: Partial<PartyDraft>) => void;
  highlighted: boolean;
  locked: boolean;
  lockedMessage?: string;
  loadFailed?: boolean;
  loadFailedMessage?: string;
  onRetry?: () => void;
}) {
  const colors = useColors();
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <AppText variant="heading">{title}</AppText>
        {highlighted ? (
          <Feather name="alert-circle" size={16} color={colors.destructive} />
        ) : null}
      </View>
      {subtitle ? (
        <AppText variant="caption" color={colors.mutedForeground}>
          {subtitle}
        </AppText>
      ) : null}
      {loadFailed ? (
        // A transient load failure — surface a retryable message instead of an
        // eternal skeleton.
        <Card style={{ gap: 12 }}>
          <Banner
            tone="error"
            message={
              loadFailedMessage ??
              "We couldn't load these details. Check your connection and try again."
            }
          />
          {onRetry ? (
            <AppButton
              label="Try again"
              icon="refresh-cw"
              variant="secondary"
              fullWidth={false}
              onPress={onRetry}
            />
          ) : null}
        </Card>
      ) : locked ? (
        <Card>
          <AppText variant="body" color={colors.mutedForeground}>
            {lockedMessage ??
              "These details are managed by your accounting firm. Ask them to correct this record."}
          </AppText>
        </Card>
      ) : draft ? (
        <Card
          style={{
            gap: 12,
            borderColor: highlighted ? colors.destructive : colors.border,
            borderWidth: highlighted ? 1 : StyleSheet.hairlineWidth,
          }}
        >
          <TextField
            label="Legal name"
            value={draft.legalName}
            onChangeText={(t) => onChange({ legalName: t })}
            placeholder="Registered business name"
          />
          <TextField
            label="TIN"
            value={draft.tin}
            onChangeText={(t) => onChange({ tin: t })}
            placeholder="12345678-0001"
            autoCapitalize="characters"
            hint={
              highlighted
                ? "The submission service rejected a TIN on this invoice. Check this number before trying again."
                : undefined
            }
          />
          <TextField
            label="CAC number (optional)"
            value={draft.cacNumber}
            onChangeText={(t) => onChange({ cacNumber: t })}
            placeholder="RC123456"
            autoCapitalize="characters"
          />
          <TextField
            label="Street"
            value={draft.street}
            onChangeText={(t) => onChange({ street: t })}
            placeholder="Street address"
          />
          <TextField
            label="City"
            value={draft.city}
            onChangeText={(t) => onChange({ city: t })}
            placeholder="City"
          />
        </Card>
      ) : (
        <CardSkeleton lines={3} />
      )}
    </View>
  );
}
