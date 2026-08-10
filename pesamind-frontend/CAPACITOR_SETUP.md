# Building PesaMind as a real .apk / .ipa (Capacitor)

## What's already done for you

- `capacitor.config.js` - app ID `com.pesamind.app`, points at this
  project's own `dist` build output.
- `package.json` - Capacitor core/CLI added as dependencies, plus three
  new scripts: `cap:sync`, `cap:android`, `cap:ios`.
- Verified `src/api.js` already always calls the real production backend
  (`https://pesamind-backend-n6z1.onrender.com`) regardless of where the
  app is running - a packaged app has no "current website" to infer a
  backend URL from the way a browser does, so this matters and it's
  already handled correctly.

## Compatibility check - good news

Three browser APIs this app uses were checked for how they behave inside
a native WebView, since that's a common source of surprises when wrapping
a web app:

- **Voice logging** (Web Speech API) - often unavailable inside embedded
  WebViews. Already handled: the app checks for support and shows an
  honest "voice input isn't supported, please add manually" message
  rather than crashing or (the old, since-fixed behavior) fabricating a
  fake transcript.
- **Biometric login** (WebAuthn) - checks `PublicKeyCredential`
  availability with a try/catch, falls back to password login cleanly if
  unsupported.
- **Receipt camera capture** - standard HTML file input with `capture`,
  which generally works fine in both Android and iOS WebViews without any
  plugin. If it ever proves unreliable on a specific device, the
  Capacitor Camera plugin is a natural upgrade path - not needed to start.

None of these needed code changes to be safe to wrap - they already fail
honestly rather than silently.

## Prerequisites

- **For the Android build (.apk)**: Android Studio (developer.android.com/studio), any OS (Windows/Mac/Linux)
- **For the iOS build (.ipa)**: a Mac with Xcode (developer.apple.com/xcode) - this is a hard Apple requirement, there's no way around needing a real Mac for this specific step
- Node.js already installed (you have this, since you're running this project already)

## One-time setup

From inside the `pesamind-frontend` folder:

```
npm install
npx cap init
```

When `cap init` asks for the app name and app ID, it will likely already
pick up the values from `capacitor.config.js` - confirm they match
`PesaMind` and `com.pesamind.app`, or just press enter to accept.

Then add each platform you want to build for:

```
npx cap add android
npx cap add ios
```

This creates two new folders, `android/` and `ios/` - these are real
native project folders (Android Studio / Xcode projects respectively).
They get committed to your repo like any other project files.

## Building the Android .apk

```
npm run cap:android
```

This builds the web app, syncs it into the native Android project, and
opens Android Studio. From there:
1. Let Gradle finish syncing (first time takes a few minutes)
2. Build -> Build Bundle(s) / APK(s) -> Build APK(s)
3. The `.apk` lands in `android/app/build/outputs/apk/debug/`

That debug APK can be installed directly on an Android phone for testing
(enable "Install from unknown sources" on the phone first). A real
Play Store release needs a signed release build, which Android Studio's
Build -> Generate Signed Bundle/APK menu walks through - you'll need to
create a signing key the first time, and keep it safe, since Google
requires the same key for every future update to the same app listing.

## Building the iOS .ipa

On a Mac, with Xcode installed:

```
npm run cap:ios
```

This builds the web app, syncs it into the native Xcode project, and
opens Xcode. From there:
1. Select your Apple Developer team under Signing & Capabilities (you'll
   need a free or paid Apple Developer account)
2. Product -> Archive
3. Once archived, the Organizer window lets you export an `.ipa` or
   upload straight to TestFlight/App Store Connect

Unlike Android, Apple doesn't allow installing an `.ipa` on a real iPhone
without either a paid Apple Developer account ($99/year) or using
Xcode's own device-install feature during development.

## After any code update

Whenever I send you an updated pesamind-frontend.zip, the sync step is
the same each time:

```
npm run cap:sync
```

This rebuilds the web app and copies the new build into both the
`android/` and `ios/` native projects - then re-open Android Studio /
Xcode and re-build as above.

## Push notifications - worth knowing before you rely on this

The app's current push notification setup uses web push (a service
worker). Once wrapped as a native app, Capacitor's own Push Notifications
plugin is the more reliable path for real native push (via Firebase Cloud
Messaging on Android, APNs on iOS) - the current web push implementation
may not work the same way, or at all, inside the native shell. This is a
real, separate piece of follow-up work, not something this setup handles
automatically - flagging it now rather than let it be a surprise later.
