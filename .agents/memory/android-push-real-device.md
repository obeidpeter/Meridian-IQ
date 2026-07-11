---
name: Android push on real devices
description: Constraints for getting Expo push notifications to display on physical Android phones.
---

## Expo Go on Android cannot receive remote push (SDK 53+)
Since Expo SDK 53 (this app is on 54), remote push notifications were removed from Expo Go on Android. A development build (EAS) with FCM credentials is required; Expo Go on iOS still supports push.
**Why:** users testing via the QR code in Expo Go on Android will never see a notification, even though the server-side pipeline reports "sent".
**How to apply:** the mobile token acquisition detects `Constants.executionEnvironment === StoreClient` on Android and returns a friendly "use a development build" reason. Real-device Android testing needs: `eas init` (adds projectId to app.json — required by `getExpoPushTokenAsync` in dev builds), `eas credentials` for FCM, then `eas build --profile development --platform android`.

## EAS dev builds bake the API domain at build time
`EXPO_PUBLIC_DOMAIN` is read via `process.env` and inlined into the JS bundle at build time; the Replit workflow sets it, but an EAS build on the user's machine won't — the app would call `https://undefined`. It is pre-wired in `eas.json` build profile env (development + preview) with the repl's dev domain; update it there if the app gets a deployed domain.
Also: installing `expo-dev-client` flips `expo start` to development-build mode — the workflow QR now targets the dev client (Expo Go users must press "s" in the terminal to switch).

## Android 8+ needs a notification channel
Expo's push service delivers to the "default" channel unless a channelId is specified; if no channel exists, Android can silently drop or downgrade notifications. The app creates a "default" channel (max importance) before requesting the token.
