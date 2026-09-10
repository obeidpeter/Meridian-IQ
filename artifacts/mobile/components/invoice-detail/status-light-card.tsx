import { Feather } from "@expo/vector-icons";
import type { StatusLight } from "@workspace/api-client-react";
import React from "react";
import { View } from "react-native";

import { AppText, Card, Skeleton } from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { statusLightPresentation } from "@/lib/invoice-detail";

import { styles } from "./styles";

/**
 * The deterministic compliance light: a skeleton while it loads, the card
 * once it has answered, nothing at all when it could not (progressive
 * enhancement — the light never gates the rest of the screen).
 */
export function StatusLightCard({
  query,
}: {
  query: { isLoading: boolean; data: StatusLight | undefined };
}) {
  const colors = useColors();
  const statusLight = query.data;
  const {
    lightMeta,
    lightDotColor,
    lightIconColor,
    lightLabelColor,
    lightA11yLabel,
  } = statusLightPresentation(statusLight, colors);

  return query.isLoading ? (
    <Card>
      <View style={{ gap: 8 }}>
        <Skeleton height={16} width="35%" />
        <Skeleton height={12} width="80%" />
      </View>
    </Card>
  ) : statusLight && lightMeta ? (
    <Card>
      <View
        accessible
        accessibilityLabel={lightA11yLabel}
        testID="card-status-light"
      >
        <View style={styles.bannerRow}>
          <View style={[styles.lightDot, { backgroundColor: lightDotColor }]} />
          <Feather name={lightMeta.icon} size={18} color={lightIconColor} />
          <AppText variant="heading" color={lightLabelColor}>
            {lightMeta.label}
          </AppText>
        </View>
        {statusLight.reasons.length > 0 ? (
          <View style={{ marginTop: 8, gap: 2 }}>
            {statusLight.reasons.map((r, i) => (
              <AppText key={i} variant="caption" color={colors.mutedForeground}>
                {r}
              </AppText>
            ))}
          </View>
        ) : null}
        <AppText variant="label" style={{ marginTop: 10 }}>
          Recommended action: {statusLight.recommendedAction}
        </AppText>
      </View>
    </Card>
  ) : null;
}
