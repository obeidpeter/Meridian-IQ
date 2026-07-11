import { Feather } from "@expo/vector-icons";
import * as Network from "expo-network";
import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";

/**
 * A thin banner shown at the very top while the device is offline, so users know
 * their actions may not reach the server (React Native apps spend a lot of time
 * on flaky/absent networks). Rendered as an absolutely-positioned overlay so it
 * never shifts the navigator layout; `pointerEvents="none"` lets taps pass
 * through. React Query's onlineManager (see lib/query.ts) uses the same
 * expo-network signal to pause/resume queries.
 */
export function OfflineBanner() {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const state = Network.useNetworkState();
  // Only show when we positively know the device is disconnected (undefined
  // during the first tick should not flash the banner).
  if (state.isConnected !== false) return null;

  return (
    <View
      pointerEvents="none"
      accessibilityLiveRegion="polite"
      accessibilityRole="alert"
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 100,
        paddingTop: insets.top,
        backgroundColor: colors.warning,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          gap: 8,
          alignItems: "center",
          justifyContent: "center",
          paddingVertical: 6,
          paddingHorizontal: 16,
        }}
      >
        <Feather name="wifi-off" size={14} color={colors.warningForeground} />
        <Text
          style={{
            fontFamily: "Inter_600SemiBold",
            fontSize: 12,
            color: colors.warningForeground,
          }}
        >
          You're offline — changes may not save
        </Text>
      </View>
    </View>
  );
}
