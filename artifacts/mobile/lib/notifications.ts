import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { PushDeviceInputPlatform } from "@workspace/api-client-react";

/** The device platform value the API expects for push registration. */
export function devicePlatform(): PushDeviceInputPlatform {
  if (Platform.OS === "ios") return PushDeviceInputPlatform.ios;
  if (Platform.OS === "android") return PushDeviceInputPlatform.android;
  return PushDeviceInputPlatform.web;
}

export interface PushTokenResult {
  ok: boolean;
  token?: string;
  reason?: string;
}

/**
 * Request notification permission and resolve an Expo push token.
 *
 * Returns a structured result rather than throwing so callers can surface a
 * friendly message. Gracefully degrades in Expo Go / web where push tokens
 * are unavailable.
 */
export async function acquireExpoPushToken(): Promise<PushTokenResult> {
  if (Platform.OS === "web") {
    return { ok: false, reason: "Push notifications aren't available on web." };
  }

  try {
    const settings = await Notifications.getPermissionsAsync();
    let granted =
      settings.granted ||
      settings.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;

    if (!granted && settings.canAskAgain !== false) {
      const request = await Notifications.requestPermissionsAsync();
      granted =
        request.granted ||
        request.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
    }

    if (!granted) {
      return {
        ok: false,
        reason: "Notification permission was denied. Enable it in Settings.",
      };
    }

    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ??
      Constants.easConfig?.projectId;

    const tokenResponse = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined,
    );

    if (!tokenResponse.data) {
      return { ok: false, reason: "Could not obtain a push token." };
    }

    return { ok: true, token: tokenResponse.data };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Push setup failed.";
    return { ok: false, reason: message };
  }
}
