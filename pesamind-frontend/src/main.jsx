import React from "react";
import ReactDOM from "react-dom/client";
import { Capacitor } from "@capacitor/core";
import { CapacitorPasskey } from "@capgo/capacitor-passkey";
import App from "./PersonalFinanceApp.jsx";
import "./index.css";

// Registers the push-notification service worker. Silently no-ops on
// browsers without support (Safari on older iOS, some in-app webviews) —
// the rest of the app works fine either way, this just means the "enable
// push notifications" option won't appear there.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

// Installs the browser-style WebAuthn shim on native platforms only — on
// the regular website, the browser's own navigator.credentials already
// works natively and doesn't need or want this. Once installed, the
// app's existing WebAuthn code (via @simplewebauthn/browser) gets
// forwarded to Android's native Credential Manager transparently, no
// changes needed at the call sites themselves.
if (Capacitor.isNativePlatform()) {
  CapacitorPasskey.autoShimWebAuthn().catch(() => {});
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
