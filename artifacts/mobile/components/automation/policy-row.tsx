import type { ClerkActionPolicy } from "@workspace/api-client-react";
import React from "react";
import { View } from "react-native";

import { AppButton, AppText, Badge } from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import {
  isPolicyPaused,
  policyKindLabel,
  policyStatusLine,
} from "@/lib/automation";

import { styles } from "./styles";

export function PolicyRow({
  policy,
  canAct,
  busy,
  onPause,
  onResume,
  onRevoke,
}: {
  policy: ClerkActionPolicy;
  canAct: boolean;
  busy: boolean;
  onPause: () => void;
  onResume: () => void;
  onRevoke: () => void;
}) {
  const colors = useColors();
  const paused = isPolicyPaused(policy);
  const statusLine = policyStatusLine(policy);
  return (
    <View
      style={{ gap: 8 }}
      accessible
      accessibilityLabel={`${policyKindLabel(policy.kind)}, ${statusLine}`}
      testID={`policy-${policy.kind}`}
    >
      <View style={styles.inlineRow}>
        <AppText variant="label" style={{ flexShrink: 1 }}>
          {policyKindLabel(policy.kind)}
        </AppText>
        {/* PAUSED is prominent: an amber badge, not just a quiet line — a
            paused grant means the daily sweep is NOT running. */}
        {paused ? <Badge label="Paused" tone="warning" /> : null}
      </View>
      <View testID={`text-policy-status-${policy.kind}`}>
        <AppText
          variant="caption"
          color={paused ? colors.warning : colors.mutedForeground}
        >
          {statusLine}
        </AppText>
      </View>
      {canAct ? (
        <View style={styles.buttonRow}>
          <View style={{ flex: 1 }}>
            {paused ? (
              <AppButton
                label="Resume"
                icon="play"
                variant="secondary"
                onPress={onResume}
                disabled={busy}
                testID={`button-policy-resume-${policy.kind}`}
              />
            ) : (
              <AppButton
                label="Pause"
                icon="pause"
                variant="secondary"
                onPress={onPause}
                disabled={busy}
                testID={`button-policy-pause-${policy.kind}`}
              />
            )}
          </View>
          <View style={{ flex: 1 }}>
            <AppButton
              label="Revoke"
              icon="x-circle"
              variant="ghost"
              onPress={onRevoke}
              disabled={busy}
              testID={`button-policy-revoke-${policy.kind}`}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}
