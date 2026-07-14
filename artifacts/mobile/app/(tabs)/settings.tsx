import Constants from "expo-constants";
import {
  getGetAlertPreferencesQueryKey,
  useGetAlertPreferences,
  useRegisterPushDevice,
  useSendTestAlert,
  useUnregisterPushDevice,
  useUpdateAlertPreferences,
} from "@workspace/api-client-react";
import type { AlertPreferences } from "@workspace/api-client-react";
import React, { useCallback, useRef, useState } from "react";
import {
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  AppButton,
  AppText,
  Card,
  CardSkeleton,
  Divider,
  ErrorState,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { acquireExpoPushToken, devicePlatform } from "@/lib/notifications";
import { queryClient } from "@/lib/query";
import { useSession } from "@/lib/session";

type ToggleKey =
  | "whatsappEnabled"
  | "smsEnabled"
  | "emailEnabled"
  | "pushEnabled"
  | "deadlineAlerts"
  | "failureAlerts"
  | "penaltyAlerts";

// Present raw channel identifiers with their conventional casing.
const CHANNEL_LABELS: Record<string, string> = {
  whatsapp: "WhatsApp",
  sms: "SMS",
  email: "Email",
  push: "Push",
};

function channelLabel(channel: string): string {
  return CHANNEL_LABELS[channel] ?? channel;
}

function SettingRow({
  title,
  subtitle,
  value,
  onValueChange,
  disabled = false,
}: {
  title: string;
  subtitle?: string;
  value: boolean;
  onValueChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  const colors = useColors();
  return (
    <View style={styles.row}>
      <View style={{ flex: 1, paddingRight: 12 }}>
        <AppText variant="label">{title}</AppText>
        {subtitle ? (
          <AppText
            variant="caption"
            color={colors.mutedForeground}
            style={{ marginTop: 2 }}
          >
            {subtitle}
          </AppText>
        ) : null}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        accessibilityLabel={title}
        accessibilityHint={subtitle}
        accessibilityState={{ checked: value, disabled }}
        trackColor={{ true: colors.primary, false: colors.secondary }}
        thumbColor="#ffffff"
      />
    </View>
  );
}

export default function SettingsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { me, clientPartyId, signOut, switchClient, setPushToken, getPushToken } =
    useSession();
  const [pushBusy, setPushBusy] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const prefsQuery = useGetAlertPreferences(clientPartyId ?? "", {
    query: {
      enabled: !!clientPartyId,
      queryKey: getGetAlertPreferencesQueryKey(clientPartyId ?? ""),
    },
  });

  // Optimistic local draft. Toggles apply to the draft immediately and each
  // write is built from the latest draft (not a possibly-stale query
  // snapshot), then PUTs are serialized through a promise queue so rapid
  // consecutive toggles can never overwrite each other out of order.
  const [draft, setDraftState] = useState<AlertPreferences | null>(null);
  const draftRef = useRef<AlertPreferences | null>(null);
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const setDraft = useCallback((next: AlertPreferences | null) => {
    draftRef.current = next;
    setDraftState(next);
  }, []);

  const prefs = draft ?? prefsQuery.data;

  const updatePrefs = useUpdateAlertPreferences();
  const registerDevice = useRegisterPushDevice();
  const unregisterDevice = useUnregisterPushDevice();
  const testAlert = useSendTestAlert();

  const savePref = useCallback(
    (key: ToggleKey, value: boolean) => {
      if (!clientPartyId) return;
      const base = draftRef.current ?? prefsQuery.data;
      if (!base) return;
      const next: AlertPreferences = { ...base, [key]: value };
      setDraft(next);
      writeQueueRef.current = writeQueueRef.current.then(async () => {
        try {
          await updatePrefs.mutateAsync({
            id: clientPartyId,
            data: {
              whatsappEnabled: next.whatsappEnabled,
              smsEnabled: next.smsEnabled,
              emailEnabled: next.emailEnabled,
              pushEnabled: next.pushEnabled,
              deadlineAlerts: next.deadlineAlerts,
              failureAlerts: next.failureAlerts,
              penaltyAlerts: next.penaltyAlerts,
            },
          });
          await queryClient.invalidateQueries({
            queryKey: getGetAlertPreferencesQueryKey(clientPartyId),
          });
          // Release the draft only if no newer toggle superseded this write.
          if (draftRef.current === next) {
            setDraft(null);
          }
        } catch {
          // Revert to the server's state and tell the user.
          if (draftRef.current === next) {
            setDraft(null);
          }
          Alert.alert(
            "Could not save",
            "Your preference was not saved. Please try again.",
          );
        }
      });
    },
    [clientPartyId, prefsQuery.data, setDraft, updatePrefs],
  );

  const handlePushToggle = useCallback(
    async (next: boolean) => {
      if (!clientPartyId || pushBusy) return;
      setPushBusy(true);
      try {
        if (next) {
          if (Platform.OS === "web") {
            // No device push on web — still record the preference so other
            // registered devices (e.g. the user's phone) receive alerts.
            savePref("pushEnabled", true);
            return;
          }
          const result = await acquireExpoPushToken();
          if (!result.ok || !result.token) {
            Alert.alert(
              "Push unavailable",
              result.reason ?? "Could not set up push notifications.",
            );
            return;
          }
          await registerDevice.mutateAsync({
            data: {
              expoPushToken: result.token,
              platform: devicePlatform(),
            },
          });
          await setPushToken(result.token);
          savePref("pushEnabled", true);
        } else {
          const stored = await getPushToken();
          if (stored) {
            try {
              await unregisterDevice.mutateAsync({
                data: { expoPushToken: stored },
              });
            } catch {
              // Best effort — the preference below still disables delivery.
            }
            await setPushToken(null);
          }
          savePref("pushEnabled", false);
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Push setup failed.";
        Alert.alert("Push notifications", message);
      } finally {
        setPushBusy(false);
      }
    },
    [
      clientPartyId,
      pushBusy,
      savePref,
      registerDevice,
      unregisterDevice,
      setPushToken,
      getPushToken,
    ],
  );

  const handleTestAlert = useCallback(() => {
    if (!clientPartyId) return;
    testAlert.mutate(
      { id: clientPartyId },
      {
        onSuccess: (results) => {
          if (!results.length) {
            Alert.alert(
              "Test alert",
              "No channels are enabled. Turn on at least one channel first.",
            );
            return;
          }
          const lines = results.map((r) => {
            const status = r.status === "sent" ? "sent" : `failed`;
            return `${channelLabel(r.channel)}: ${status}${
              r.status !== "sent" && r.detail ? ` — ${r.detail}` : ""
            }`;
          });
          Alert.alert("Test alert sent", lines.join("\n"));
        },
        onError: () => {
          Alert.alert("Test alert", "Could not send the test alert.");
        },
      },
    );
  }, [clientPartyId, testAlert]);

  const handleSignOut = useCallback(() => {
    const run = async () => {
      setSigningOut(true);
      try {
        await signOut();
      } finally {
        setSigningOut(false);
      }
    };
    if (Platform.OS === "web") {
      void run();
      return;
    }
    Alert.alert("Sign out", "Are you sure you want to sign out?", [
      { text: "Cancel", style: "cancel" },
      { text: "Sign out", style: "destructive", onPress: () => void run() },
    ]);
  }, [signOut]);

  const version = Constants.expoConfig?.version ?? "1.0.0";

  return (
    <ScrollView
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={[
        styles.content,
        { paddingBottom: insets.bottom + 100 },
      ]}
      showsVerticalScrollIndicator={false}
    >
      <AppText variant="overline" color={colors.mutedForeground} style={styles.sectionLabel}>
        Alert channels
      </AppText>
      {prefsQuery.isLoading ? (
        <CardSkeleton lines={4} />
      ) : prefsQuery.isError || !prefs ? (
        <Card>
          <ErrorState
            message="Alert preferences could not be loaded."
            onRetry={() => void prefsQuery.refetch()}
          />
        </Card>
      ) : (
        <>
          <Card padded={false} style={{ paddingHorizontal: 16 }}>
            <SettingRow
              title="Push notifications"
              subtitle={
                Platform.OS === "web"
                  ? "Delivered to your registered mobile devices"
                  : "Alerts delivered to this device"
              }
              value={prefs.pushEnabled}
              onValueChange={(next) => void handlePushToggle(next)}
              disabled={pushBusy}
            />
            <Divider />
            <SettingRow
              title="WhatsApp"
              subtitle="Alerts via WhatsApp message"
              value={prefs.whatsappEnabled}
              onValueChange={(next) => savePref("whatsappEnabled", next)}
            />
            <Divider />
            <SettingRow
              title="SMS"
              subtitle="Alerts via text message"
              value={prefs.smsEnabled}
              onValueChange={(next) => savePref("smsEnabled", next)}
            />
            <Divider />
            <SettingRow
              title="Email"
              subtitle="Alerts via email"
              value={prefs.emailEnabled}
              onValueChange={(next) => savePref("emailEnabled", next)}
            />
          </Card>

          <AppText variant="overline" color={colors.mutedForeground} style={styles.sectionLabel}>
            Alert types
          </AppText>
          <Card padded={false} style={{ paddingHorizontal: 16 }}>
            <SettingRow
              title="Deadline reminders"
              subtitle="Upcoming and overdue filing deadlines"
              value={prefs.deadlineAlerts}
              onValueChange={(next) => savePref("deadlineAlerts", next)}
            />
            <Divider />
            <SettingRow
              title="Transmission failures"
              subtitle="Invoices that failed to fiscalise"
              value={prefs.failureAlerts}
              onValueChange={(next) => savePref("failureAlerts", next)}
            />
            <Divider />
            <SettingRow
              title="Penalty warnings"
              subtitle="Estimated exposure before penalties accrue"
              value={prefs.penaltyAlerts}
              onValueChange={(next) => savePref("penaltyAlerts", next)}
            />
          </Card>

          <View style={{ marginTop: 16 }}>
            <AppButton
              label="Send test alert"
              icon="bell"
              variant="secondary"
              loading={testAlert.isPending}
              onPress={handleTestAlert}
            />
          </View>
        </>
      )}

      <AppText variant="overline" color={colors.mutedForeground} style={styles.sectionLabel}>
        Account
      </AppText>
      <Card>
        <AppText variant="label">{me?.fullName ?? "Signed in"}</AppText>
        <AppText
          variant="caption"
          color={colors.mutedForeground}
          style={{ marginTop: 2 }}
        >
          {me?.email ?? ""}
        </AppText>
        {/* Firm principals (no bound client) can drop the chosen client and
            re-open the client picker. */}
        {!me?.clientPartyId ? (
          <View style={{ marginTop: 14 }}>
            <AppButton
              label="Switch client"
              icon="users"
              variant="secondary"
              onPress={() => void switchClient()}
            />
          </View>
        ) : null}
        <View style={{ marginTop: 14 }}>
          <AppButton
            label="Sign out"
            icon="log-out"
            variant="destructive"
            loading={signingOut}
            onPress={handleSignOut}
          />
        </View>
      </Card>

      <AppText
        variant="caption"
        color={colors.mutedForeground}
        style={{ textAlign: "center", marginTop: 24 }}
      >
        MeridianIQ Companion v{version}
      </AppText>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  sectionLabel: {
    marginTop: 20,
    marginBottom: 8,
    marginLeft: 4,
    letterSpacing: 0.6,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
  },
});
