# Building PesaMind as a real .apk / .ipa (Capacitor)

## What's already done for you

- `capacitor.config.json` - app ID `com.pesamind.app`, points at this
  project's own `dist` build output. (Originally a `.js` file, but
  Capacitor's CLI didn't reliably read values from the ES Module syntax
  this project's `"type": "module"` setting requires - JSON sidesteps
  that entirely, and it's the format Capacitor's own tooling generates by
  default anyway.)
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
- **Receipt camera capture** - genuinely needs one manual step: iOS
  requires explicit privacy usage descriptions in `Info.plist` before it
  will open the camera at all, even for a plain HTML file input like this
  app uses (not just the dedicated Capacitor Camera plugin). Without
  these keys, tapping to scan a receipt does nothing - no error, no
  crash, just silence. See "Camera not responding on iOS" below for the
  exact fix - this was incorrectly described as working out of the box
  in an earlier version of this guide.

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
```

**Skip `npx cap init`** - `capacitor.config.js` already exists in this
project (app ID `com.pesamind.app`, app name "PesaMind" already set), so
running `cap init` will fail with an error about a "non-JSON
configuration file" since it tries to create a fresh config that
conflicts with the one already here. There's nothing `cap init` would add
that isn't already in place - go straight to adding platforms below.

Add each platform you want to build for:

```
npx cap add android
npx cap add ios
```

This creates two new folders, `android/` and `ios/` - these are real
native project folders (Android Studio / Xcode projects respectively).
They get committed to your repo like any other project files.

**Note**: `@capacitor/android` and `@capacitor/ios` are already listed in
`package.json`, so `npm install` (the one-time setup step above) already
pulled them in - `cap add` needs the platform package present first, it
does not install it for you.

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

## Camera not responding on iOS

If tapping to scan a receipt does nothing on a real iPhone (no error, no
camera opens, nothing happens) - this is the fix. iOS requires your app
to declare *why* it wants camera/photo access before it will grant it,
even for a plain HTML file input.

1. In Xcode, find `Info.plist` in the file navigator (inside `App > App`)
2. Right-click it in the file list and choose **Open As > Source Code**
   (this shows the raw XML, easier to edit precisely than the property
   list UI)
3. Find the closing `</dict>` tag near the bottom, and add these three
   entries just before it:
   ```xml
   <key>NSCameraUsageDescription</key>
   <string>PesaMind needs camera access to scan receipts.</string>
   <key>NSPhotoLibraryUsageDescription</key>
   <string>PesaMind needs photo library access to attach receipt photos.</string>
   <key>NSPhotoLibraryAddUsageDescription</key>
   <string>PesaMind needs photo library access to save receipt photos.</string>
   ```
4. Save the file (Cmd+S)
5. Run the app again (play button) - no rebuild/resync needed for an
   Info.plist-only change, Xcode picks it up directly

The first time you tap to scan a receipt after this, iOS will show a
real permission popup ("PesaMind Would Like to Access the Camera") with
the exact text from NSCameraUsageDescription above - that's the
expected, correct behavior this was missing before.

Note: since ios/ isn't tracked in Git (it's regenerated locally via
npx cap add ios), this edit needs to be redone if you ever delete and
recreate that folder from scratch on a new machine.

## QR scanning - native plugin setup (@capacitor/barcode-scanner)

QR scanning now uses the official Capacitor Barcode Scanner plugin
instead of the browser's own camera-streaming API, which proved
unreliable inside Capacitor's iOS WebView (see the note above about the
receipt camera fix - this is a related but distinct issue, since QR
scanning needs a live, continuously-updating camera view rather than a
single photo). This plugin uses real native camera access on both
platforms instead.

After pulling this update:

```
npm install
npx cap sync
```

**iOS**: no extra setup needed beyond what's already there - it uses the
same NSCameraUsageDescription key already added to Info.plist for
receipt scanning.

**Android**: this plugin requires a higher minimum Android SDK version
(26) than Capacitor's own default. Since `android/` isn't tracked in
Git either, this needs to be set directly on each machine that builds
for Android:

1. Open `android/variables.gradle` in a text editor
2. Find the line `minSdkVersion = ...` (or add one if missing) inside
   the `ext { }` block
3. Set it to:
   ```gradle
   ext {
       minSdkVersion = 26
   }
   ```
4. Save, then re-sync: `npx cap sync android`

**Also required on Android**: the plugin's Android side depends on a
package hosted via JitPack, which isn't in the project's default Gradle
repositories - without this, the build fails with something like
"Could not find any matches for com.github.outsystems:osbarcode-android".

1. Open `android/build.gradle` (the root-level one, not `android/app/build.gradle`)
2. Find the `allprojects { repositories { ... } }` block
3. Add this line inside it:
   ```gradle
   maven { url 'https://jitpack.io' }
   ```
4. If that block isn't in `build.gradle`, check `android/settings.gradle`
   instead - some Gradle setups use a `dependencyResolutionManagement { repositories { ... } }`
   block there instead. Add the same line to whichever one actually has it.
5. In Android Studio: File -> Sync Project with Gradle Files, then run again

**A version note worth knowing**: this plugin's current documentation is
written against Capacitor v8, while this project is on Capacitor v6.
`npm install` should resolve a compatible version automatically, but if
`npx cap sync` shows any version-conflict warnings after installing,
that's the first thing to look at.

## Native push notifications (Android)

This replaces the old web-push system for the native app - real Android
push via Firebase Cloud Messaging (FCM), using the official
`@capacitor/push-notifications` plugin. The web push system stays intact
and unchanged for anyone using the regular website; both paths now run
through the same backend `sendPushToUser()` call, so nothing else in the
codebase needed to change.

iOS is deliberately not covered here - real iOS push needs a paid Apple
Developer account (APNs certificates), same blocker as Face ID. This is
Android-only for now.

### Step 1: Create a Firebase project (free, one-time, web console)

1. Go to [console.firebase.google.com](https://console.firebase.google.com/)
   and click **Add project**
2. Name it (e.g. "PesaMind"), accept the terms, click through to create it
   - Google Analytics is optional, safe to skip

### Step 2: Register the Android app with Firebase

1. On the Firebase project's Overview page, click the **Android** icon
   to add a new Android app
2. **Android package name** must exactly match `com.pesamind.app` (the
   `appId` in `capacitor.config.json`) - this is the one field that must
   be precise, everything else is optional
3. Click **Register app**
4. Download the `google-services.json` file when prompted

### Step 3: Place `google-services.json` in the Android project

Move the downloaded file to:
```
android/app/google-services.json
```
No further Gradle edits needed for this one - the plugin already
includes the necessary Firebase Messaging dependency in its own
`build.gradle`, confirmed directly from Capacitor's own documentation.

Since `android/` isn't tracked in Git, this file needs to be placed
again if that folder is ever deleted and regenerated on a new machine -
same situation as the `Info.plist` and `network security` edits.

### Step 4: Install the plugin and sync

```
npm install
npx cap sync android
```

### Step 5: Create a service account for the backend to send push

This is separate from `google-services.json` - that file is client-side
and ships inside the app; this is a private server-side credential that
must never be committed to Git or shared publicly.

1. In the Firebase console, go to **Project Settings** (gear icon) →
   **Service Accounts** tab
2. Click **Generate new private key** - downloads a JSON file
3. Open that file, copy its **entire contents** as one block
4. On Render, go to the backend service → **Environment**, add a new
   variable:
   - Key: `FIREBASE_SERVICE_ACCOUNT_JSON`
   - Value: paste the entire JSON file's contents as a single value
5. Save - Render will redeploy the backend automatically

### Step 6: Run a schema migration

The backend now has a new `PushDeviceToken` table. After deploying,
run `npm run prisma:migrate` against the production database (this
project's existing script for applying schema changes).

### Step 7: Build and test

```
npm run build
npx cap sync android
npx cap open android
```

Run on a real Android phone (the emulator can receive FCM push too, but
a real device is the more reliable test). In the app:

1. Go to **Profile → Push notifications**
2. Tap **Enable notifications** - Android grants silently, no prompt
3. Tap **Send test** - a real system notification should arrive within
   a few seconds

If "Send test" doesn't produce a notification, the most likely causes,
in order of likelihood:
- `FIREBASE_SERVICE_ACCOUNT_JSON` isn't set correctly on Render (check
  the backend's logs for "Failed to initialize Firebase Admin")
- The Android package name in Firebase doesn't exactly match
  `com.pesamind.app`
- `google-services.json` wasn't placed in `android/app/` before the
  build
