import { Stack, useRouter } from "expo-router";
import { StyleSheet, View } from "react-native";

import { AppButton, AppText } from "@/components/ui";
import { useColors } from "@/hooks/useColors";

export default function NotFoundScreen() {
  const colors = useColors();
  const router = useRouter();

  return (
    <>
      <Stack.Screen options={{ title: "Oops!" }} />
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <AppText variant="title" style={{ textAlign: "center" }}>
          {"This screen doesn't exist."}
        </AppText>
        <AppText
          variant="body"
          color={colors.mutedForeground}
          style={{ marginTop: 8, textAlign: "center" }}
        >
          {"The page you're looking for may have moved or been removed."}
        </AppText>
        <View style={styles.action}>
          <AppButton
            label="Go home"
            icon="home"
            onPress={() => router.replace("/")}
            fullWidth={false}
          />
        </View>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  action: {
    marginTop: 24,
  },
});
