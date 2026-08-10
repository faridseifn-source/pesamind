/** @type {import('@capacitor/cli').CapacitorConfig} */
const config = {
  appId: "com.pesamind.app",
  appName: "PesaMind",
  webDir: "dist",
  // Points Capacitor's own WebView at the real bundled app files (dist/),
  // not a remote URL — the whole app ships inside the .apk/.ipa. api.js
  // already always calls the real production backend regardless of where
  // the app is running (BASE_URL falls back to the Render URL when there's
  // no VITE_API_URL set at build time), so this needs no special handling
  // here — see the note in src/api.js.
  server: {
    androidScheme: "https",
  },
};

export default config;
