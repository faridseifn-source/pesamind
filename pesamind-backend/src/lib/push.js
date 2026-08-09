const webpush = require("web-push");
const env = require("./env");
const prisma = require("./prisma");
const { getSetting } = require("./settings");

let configured = false;
function ensureConfigured() {
  if (configured) return;
  if (env.push.vapidPublicKey && env.push.vapidPrivateKey) {
    webpush.setVapidDetails(env.push.vapidSubject, env.push.vapidPublicKey, env.push.vapidPrivateKey);
  }
  configured = true;
}

/**
 * Sends a push notification to every device the user has enabled
 * notifications on. Deliberately best-effort and silent: a push failure
 * never throws back into the caller's business logic — a payment
 * completing shouldn't fail just because a notification couldn't be
 * delivered. An expired/invalid subscription (the push service returns
 * 404/410) is cleaned up automatically rather than retried forever.
 */
async function sendPushToUser(userId, { title, body, url }) {
  try {
    const enabled = (await getSetting("push_notifications_enabled")) !== "false";
    if (!enabled) return;
    if (!env.push.vapidPublicKey || !env.push.vapidPrivateKey) return; // not configured yet — skip quietly, don't crash
    ensureConfigured();

    const subs = await prisma.pushSubscription.findMany({ where: { userId } });
    if (!subs.length) return;

    const payload = JSON.stringify({ title, body, url: url || "/" });
    await Promise.all(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
          await prisma.pushSubscription.update({ where: { id: sub.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
        } catch (err) {
          if (err.statusCode === 404 || err.statusCode === 410) {
            await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
          }
          // Any other error (network blip, transient push-service issue) —
          // skip this one device, don't retry here or block the others.
        }
      })
    );
  } catch (err) {
    console.error("Push notification send failed", err); // eslint-disable-line no-console
  }
}

module.exports = { sendPushToUser };
