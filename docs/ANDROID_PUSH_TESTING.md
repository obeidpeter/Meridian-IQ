# Testing push notifications on a real Android phone

Expo Go on Android cannot receive remote push notifications (since Expo SDK 53), so a
one-time **development build** is required. Everything in the project is already
prepared — `eas.json`, the Android package id, and the `expo-dev-client` package are in
place. You only need an Expo account and the steps below, run on your own computer.

## One-time setup (on your computer)

1. Install the EAS CLI and log in with your Expo account:

   ```bash
   npm install -g eas-cli
   eas login
   ```

2. Clone/download this project, then from the `artifacts/mobile` folder:

   ```bash
   cd artifacts/mobile
   eas init          # links the app to your Expo account and adds the projectId to app.json
   eas credentials   # choose Android → set up FCM (Google service account) for push
   eas build --profile development --platform android
   ```

   - `eas init` writes an `extra.eas.projectId` entry into `app.json` — commit that change
     back to the Replit project (the push-token code reads it).
   - For `eas credentials`, follow the prompts to create/upload a Firebase (FCM v1)
     service account key. EAS walks you through creating the Firebase project if you
     don't have one.

3. When the build finishes, EAS gives you a link/QR to download the APK. Open it on
   your Android phone and install it (allow "install from unknown sources" if asked).

## Testing (phone + Replit workspace running)

1. Make sure the Replit workspace is running (the API server and the Expo dev server
   must be up).
2. Open the installed **MeridianIQ Mobile** dev build on the phone. Scan the QR code
   shown by the Expo workflow in Replit (same QR you used with Expo Go) so the dev
   build loads the app.
3. Sign in, go to **Settings**, and turn on **Push notifications**. Accept the
   notification permission prompt. The app registers the device with the API.
4. Tap **Send test alert** — a notification should appear on the phone within a few
   seconds ("MeridianIQ … Open the app for details.").
5. To see a real pre-breach alert: have an open B2C batch whose reporting deadline is
   inside the 4-hour warning margin — the scheduler sends a `b2c_window_alert` push to
   all registered devices of clients with push enabled.

## Troubleshooting

- **Toggle says "Expo Go can't receive push"** — you are in Expo Go, not the dev
  build. Open the installed APK instead.
- **Test alert says push "failed"** — check the API server logs; the Expo push API
  response detail is recorded in the messages ledger.
- **Notification never appears but "sent"** — check phone notification settings for
  the app ("Alerts" channel must be allowed); confirm FCM credentials were set up via
  `eas credentials` (without FCM, Android tokens are issued but delivery fails).
- **App can't reach the API** — the dev build talks to the Replit dev domain, which is
  only reachable while the workspace is running.
