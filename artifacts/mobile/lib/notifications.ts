import Constants, { ExecutionEnvironment } from "expo-constants";
import * as Notifications from "expo-notifications";
import type { Href } from "expo-router";
import { Platform } from "react-native";

import { PushDeviceInputPlatform } from "@workspace/api-client-react";

// Push payloads are pointer-only (PL-04/SEC-12): the notification `data`
// carries just a template key, never client details. Each key maps to the
// screen where the alert's details live, so a tap lands the user in the
// right place. Both current templates surface in the Deadlines tab — deadline
// reminders directly, and B2C window alerts as `b2c_report` deadlines.
const TEMPLATE_ROUTES: Record<string, Href> = {
  deadline_reminder: "/(tabs)/deadlines",
  b2c_window_alert: "/(tabs)/deadlines",
};

/**
 * Resolve the in-app route for a push notification's template key.
 * Returns null for unknown/missing templates so callers leave the user
 * wherever the app would normally open.
 */
export function routeForTemplate(template: unknown): Href | null {
  if (typeof template !== "string") return null;
  return TEMPLATE_ROUTES[template] ?? null;
}

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

  // Since SDK 53, Expo Go on Android no longer supports remote push
  // notifications — a development build is required.
  if (
    Platform.OS === "android" &&
    Constants.executionEnvironment === ExecutionEnvironment.StoreClient
  ) {
    return {
      ok: false,
      reason:
        "Expo Go on Android can't receive push notifications. Install a development build of the app to enable them.",
    };
  }

  try {
    // Android 8+ requires a notification channel for alerts to display.
    // Expo's push service delivers to the "default" channel unless a
    // channelId is specified, so make sure it exists with high importance.
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("default", {
        name: "Alerts",
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: "#0d7c64",
      });
    }

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
