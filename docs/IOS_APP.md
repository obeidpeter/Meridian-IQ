# Running MeridianIQ Mobile on iPhone

The mobile app is built with Expo, so the same codebase that produces the Android app
also produces the iOS app. Everything in the project is already prepared — the iOS
bundle identifier (`com.meridianiq.mobile`), build profiles in `eas.json`, and the
push-notification code paths for iOS are in place. What remains are the Apple-side
steps that only you can do, run on your own computer.

## What you need

- **An Apple ID.** Free is enough for a simulator build or a short-lived
  personal-device build.
- **Apple Developer Program membership ($99/year)** — required for TestFlight,
  push notifications (APNs), and App Store distribution. Enrol at
  [developer.apple.com/programs](https://developer.apple.com/programs/).
- **An Expo account** (free) and the EAS CLI on your computer.

## One-time setup (on your computer)

1. Install the EAS CLI and log in:

   ```bash
   npm install -g eas-cli
   eas login
   ```

2. Clone/download this project, then from the `artifacts/mobile` folder:

   ```bash
   cd artifacts/mobile
   eas init          # links the app to your Expo account and adds the projectId to app.json
   ```

   `eas init` writes an `extra.eas.projectId` entry into `app.json` — commit that
   change back to the Replit project (the push-token code reads it). If you already
   ran `eas init` for the Android build, skip this step.

## Option A — quickest look: iOS Simulator (Mac only, no Apple Developer account)

```bash
eas build --profile development-simulator --platform ios
```

When the build finishes, download the `.tar.gz`, unpack it, and drag the `.app` onto
a running iOS Simulator (Xcode required). Note: push notifications don't work in the
simulator.

## Option B — on your iPhone with push: development build

Requires Apple Developer Program membership.

```bash
eas build --profile development --platform ios
eas credentials   # choose iOS → set up Push Notifications (APNs key); EAS can create it for you
```

- During the build, EAS asks to register your iPhone (ad-hoc provisioning). Follow the
  prompt — it sends a link to open on the phone that registers the device UDID.
- When the build finishes, open the install link on your iPhone.
- Open the installed **MeridianIQ Mobile** dev build and scan the QR code shown by
  the Expo workflow in Replit so the dev build loads the app.

## Option C — share with others: TestFlight

```bash
eas build --profile production --platform ios
eas submit --platform ios
```

EAS uploads the build to App Store Connect; add testers under TestFlight. The
production build talks to the deployed API at `meridian-iq.replit.app`, so make sure
the project is published.

## Verifying push notifications on iPhone

1. Confirm APNs credentials exist: `eas credentials` → iOS → Push Notifications
   should show a key. Without it, iOS devices get tokens but deliveries fail.
2. Sign in, go to **Settings**, and turn on **Push notifications**. Accept the
   permission prompt — the app registers the device with platform `ios`.
3. Tap **Send test alert** — a notification should appear within a few seconds.
4. Tap the notification: deadline reminders open the Deadlines tab, B2C window
   alerts open the B2C tab (works from both background and a cold start).

## Troubleshooting

- **"Could not obtain a push token" in Expo Go** — push in Expo Go on iOS is
  limited and unreliable; install the development build (Option B) for supported
  push testing.
- **Test alert says push "failed"** — check the API server logs; the Expo push API
  response detail is recorded in the messages ledger.
- **Notification never appears but "sent"** — check iPhone Settings → Notifications
  → MeridianIQ Mobile is allowed; confirm the APNs key exists in `eas credentials`.
- **App can't reach the API** — dev builds talk to the Replit dev domain, which is
  only reachable while the workspace is running; production/TestFlight builds talk
  to the published app.
