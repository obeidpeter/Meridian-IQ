import type { ClerkActionDecision } from "@workspace/api-client-react";
import React from "react";
import { View } from "react-native";

import { AppText, Card } from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { DECISION_DISPLAY_CAP, decisionLine } from "@/lib/automation";

/** The evidence trail — the most recent decisions, capped; nothing when empty. */
export function RunRecordCard({
  decisions,
}: {
  decisions: ClerkActionDecision[];
}) {
  const colors = useColors();
  if (decisions.length === 0) return null;
  return (
    <View style={{ gap: 10 }}>
      <AppText variant="heading">Run record</AppText>
      <Card style={{ gap: 8 }}>
        {decisions.slice(0, DECISION_DISPLAY_CAP).map((d) => (
          <View key={d.id} testID={`decision-${d.id}`}>
            <AppText variant="caption" color={colors.mutedForeground}>
              {decisionLine(d)}
            </AppText>
          </View>
        ))}
      </Card>
    </View>
  );
}
