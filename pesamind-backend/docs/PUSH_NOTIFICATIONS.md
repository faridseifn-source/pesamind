# Push notifications — design reference

Standard Web Push (RFC 8030) with VAPID (RFC 8292) — not a third-party
push service, no Firebase/APNs account needed. Works in any browser that
supports the Push API (all major browsers except Safari on older iOS).

## How the VAPID keys were generated

VAPID keys are just a standard EC P-256 key pair — no third-party
credential, nothing to "sign up" for. The pair shipped with this project
was generated with Node's built-in `crypto` module (via structured JWK
export, not manual DER parsing — an earlier manual-parsing attempt during
development produced a corrupted private key, caught by testing sign/verify
round-trip before shipping):

```js
const crypto = require("crypto");
const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pubJwk = publicKey.export({ format: "jwk" });
const privJwk = privateKey.export({ format: "jwk" });
const b64url = (s) => Buffer.from(s, "base64url");
const vapidPublic = Buffer.concat([Buffer.from([0x04]), b64url(pubJwk.x), b64url(pubJwk.y)]).toString("base64url");
const vapidPrivate = b64url(privJwk.d).toString("base64url");
```

**Keep these stable across deploys** — rotating them invalidates every
customer's existing push subscription (they'd each need to re-enable
notifications). If you ever do need to rotate, generate a fresh pair the
same way and treat it as a breaking change communicated to users, not a
routine env var update.

## Architecture

- `lib/push.js` — the actual sending logic, using the `web-push` npm
  library (handles VAPID JWT signing and payload encryption per spec —
  not reimplemented by hand, since that cryptography is easy to get wrong).
- `lib/notify.js` — `notifyUser()`, the single place that creates an
  in-app `Notification` row AND best-effort sends a push, so the two
  channels never drift out of sync.
- Sending is always best-effort: a push failure never throws back into the
  caller's business logic. A payment completing successfully shouldn't be
  undone or blocked just because a notification couldn't be delivered.
- An expired/invalid subscription (push service responds 404/410) is
  deleted automatically on the next send attempt — no separate cleanup job.

## What's wired to send a notification today

- Wallet invitation sent / accepted
- Add-on card issued
- QR payment completed
- QR payment reversed (the more important of the two — the customer needs
  to know their money came back)
- Account blocked / unblocked by an admin
- Support ticket marked resolved

Adding a new trigger point anywhere else in the app is one call to
`notifyUser(userId, { type, title, message, url })` — no separate push-
specific code needed at the call site.

## Admin control

`push_notifications_enabled` (default `"true"`) gates BOTH new
subscriptions and sending — turning it off doesn't just hide the button,
it makes `/push/subscribe` refuse and makes every `sendPushToUser()` call
a silent no-op. The in-app notification list keeps working regardless,
since that's a separate, always-on channel.

## Frontend pieces

- `public/sw.js` — the service worker. Deliberately minimal: only handles
  `push` and `notificationclick` events, no offline caching or asset
  interception (this isn't trying to be a full offline-first PWA).
- Registered once at startup in `main.jsx`.
- `api.push.subscribe()` triggers the browser's native permission prompt
  as a side effect of calling `pushManager.subscribe()` — there's no
  separate "ask permission" step in the Push API itself.
- UI lives in Profile → "Push notifications" card, including a
  "Send test" button so a customer can confirm it's actually working on
  their specific device right after enabling it.

## Known limitations

- No admin broadcast/campaign tool (send-to-all-customers) — every
  notification today is triggered by a specific event for a specific user.
  Worth building if marketing-style announcements become a need.
- No per-notification-type opt-out (it's all-or-nothing per device) — a
  customer can't currently say "notify me about payments but not disputes."
