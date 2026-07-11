import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from "@expo-google-fonts/inter";
import { QueryClientProvider } from "@tanstack/react-query";
import { setBaseUrl } from "@workspace/api-client-react";
import { Stack, router } from "expo-router";
import * as Notifications from "expo-notifications";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect, useRef } from "react";
import { ActivityIndicator, Platform, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ClientPicker } from "@/components/client-picker";
import { OfflineBanner } from "@/components/offline-banner";
import { SignIn } from "@/components/sign-in";
import { useColors } from "@/hooks/useColors";
import { routeForTemplate } from "@/lib/notifications";
import { queryClient } from "@/lib/query";
import { SessionProvider, useSession } from "@/lib/session";

// Expo bundles run outside the web proxy and need absolute URLs to reach the
// API server. The deployment domain is injected at build time.
setBaseUrl(`https://${process.env.EXPO_PUBLIC_DOMAIN}`);

// Foreground notification presentation (native only — no-op on web).
if (Platform.OS !== "web") {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
}

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

function LoadingScreen() {
  const colors = useColors();
  return (
    <View
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: colors.background,
      }}
    >
      <ActivityIndicator size="large" color={colors.primary} />
    </View>
  );
}

// Navigate to the screen a tapped push notification points at. Runs only once
// the user is authenticated and past client selection — before that the tab
// navigator isn't mounted, so navigation would be dropped. Cold starts (app
// launched from a killed state by the tap) are covered by reading the last
// notification response once; warm taps arrive via the response listener.
function useNotificationNavigation(ready: boolean) {
  const handledColdStart = useRef(false);

  useEffect(() => {
    if (Platform.OS === "web" || !ready) return;

    const openFromResponse = (
      response: Notifications.NotificationResponse | null,
    ) => {
      const route = routeForTemplate(
        response?.notification.request.content.data?.template,
      );
      if (route) router.navigate(route);
    };

    if (!handledColdStart.current) {
      handledColdStart.current = true;
      Notifications.getLastNotificationResponseAsync()
        .then(openFromResponse)
        .catch(() => {
          // Best-effort: if the launch response can't be read, the app just
          // opens on its default screen.
        });
    }

    const subscription =
      Notifications.addNotificationResponseReceivedListener(openFromResponse);
    return () => subscription.remove();
  }, [ready]);
}

function RootLayoutNav() {
  const { status, needsClientSelection } = useSession();
  useNotificationNavigation(
    status === "authenticated" && !needsClientSelection,
  );

  if (status === "loading") return <LoadingScreen />;
  if (status === "anonymous") return <SignIn />;
  if (needsClientSelection) return <ClientPicker />;

  return (
    <Stack screenOptions={{ headerBackTitle: "Back" }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
    </Stack>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <GestureHandlerRootView style={{ flex: 1 }}>
            <KeyboardProvider>
              <SessionProvider>
                <RootLayoutNav />
                <OfflineBanner />
              </SessionProvider>
            </KeyboardProvider>
          </GestureHandlerRootView>
        </QueryClientProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
