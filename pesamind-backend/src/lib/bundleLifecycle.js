const prisma = require("./prisma");
const { badRequest, notFound, conflict } = require("./errors");
const { myCard, debitCard } = require("../modules/cards/cardHelpers");
const { notifyUser } = require("./notify");
const { writeAudit } = require("./audit");

function serializeBundle(b) {
  return {
    id: b.id, nameEn: b.nameEn, nameSw: b.nameSw, descriptionEn: b.descriptionEn, descriptionSw: b.descriptionSw,
    validity: b.validity, price: Number(b.price),
    includedTransactionTypeIds: b.includedTransactionTypeIds,
    includedTransactionCount: b.includedTransactionCount,
    maxTransactionValue: b.maxTransactionValue !== null ? Number(b.maxTransactionValue) : null,
    autoRenewDefault: b.autoRenewDefault, gracePeriodDays: b.gracePeriodDays, rolloverUnused: b.rolloverUnused,
    cancellable: b.cancellable, refundable: b.refundable,
  };
}

function serializeSubscription(s) {
  return {
    id: s.id, bundleId: s.bundleId, bundle: s.bundle ? serializeBundle(s.bundle) : undefined,
    purchasedAt: s.purchasedAt, expiresAt: s.expiresAt, transactionsUsed: s.transactionsUsed,
    status: s.status, pricePaid: Number(s.pricePaid), autoRenew: s.autoRenew,
  };
}

function computeExpiry(validity, from) {
  const d = new Date(from);
  if (validity === "DAILY") d.setDate(d.getDate() + 1);
  else if (validity === "WEEKLY") d.setDate(d.getDate() + 7);
  else if (validity === "MONTHLY") d.setMonth(d.getMonth() + 1);
  else throw badRequest("Unknown bundle validity period");
  return d;
}

/**
 * The one place a bundle is actually purchased — used by both the
 * customer-initiated purchase route and the auto-renewal job below, so the
 * two can never drift apart in behavior.
 */
async function purchaseBundleForUser(userId, bundle, { autoRenew, isRenewal = false } = {}) {
  const now = new Date();
  if (!bundle.isActive) throw notFound("This bundle isn't available");
  if (bundle.startDate && bundle.startDate > now) throw badRequest("This bundle isn't available yet");
  if (bundle.endDate && bundle.endDate < now) throw badRequest("This bundle is no longer available");

  if (!isRenewal) {
    const existingActive = await prisma.customerBundleSubscription.findFirst({
      where: { userId, bundleId: bundle.id, status: "ACTIVE", expiresAt: { gte: now } },
    });
    if (existingActive) throw conflict("You already have an active subscription to this bundle");
  }

  const price = Number(bundle.price);
  const card = await myCard(userId);
  if (Number(card.balance) < price) throw badRequest(`This bundle costs ${price.toLocaleString()} TZS — please top up first`);

  await debitCard(card.id, { type: "bundle_purchase", amount: price, label: `${bundle.nameEn} bundle${isRenewal ? " (renewal)" : ""}` });

  const subscription = await prisma.customerBundleSubscription.create({
    data: {
      userId, bundleId: bundle.id, expiresAt: computeExpiry(bundle.validity, now),
      pricePaid: price, autoRenew: autoRenew !== undefined ? autoRenew : bundle.autoRenewDefault,
    },
    include: { bundle: true },
  });

  await writeAudit(userId, isRenewal ? "fee.bundle.renewed" : "fee.bundle.purchased", { bundleId: bundle.id, subscriptionId: subscription.id, price });
  await notifyUser(userId, {
    type: "bundle_purchased",
    title: isRenewal ? "Bundle renewed" : "Bundle activated",
    message: `${bundle.nameEn} is active until ${subscription.expiresAt.toLocaleDateString()}.`,
    url: "/pay",
  });

  return subscription;
}

/**
 * Prorated refund on cancellation, based on time remaining in the
 * subscription — the default policy when a bundle is configured
 * `refundable`. An admin can still make a different one-off call via a
 * support ticket for a specific customer; this is just the automatic
 * default so most cancellations don't need manual handling at all.
 */
async function cancelSubscriptionForUser(userId, subscriptionId) {
  const sub = await prisma.customerBundleSubscription.findUnique({ where: { id: subscriptionId }, include: { bundle: true } });
  if (!sub || sub.userId !== userId) throw notFound("Subscription not found");
  if (sub.status !== "ACTIVE") throw badRequest("This subscription isn't active");
  if (!sub.bundle.cancellable) throw badRequest("This bundle can't be cancelled once purchased");

  let refundAmount = 0;
  if (sub.bundle.refundable) {
    const now = new Date();
    const totalMs = new Date(sub.expiresAt).getTime() - new Date(sub.purchasedAt).getTime();
    const remainingMs = Math.max(0, new Date(sub.expiresAt).getTime() - now.getTime());
    if (totalMs > 0 && remainingMs > 0) {
      refundAmount = Math.floor(Number(sub.pricePaid) * (remainingMs / totalMs));
    }
  }

  await prisma.customerBundleSubscription.update({ where: { id: sub.id }, data: { status: "CANCELLED" } });

  if (refundAmount >= 1) {
    const card = await myCard(userId);
    await prisma.card.update({ where: { id: card.id }, data: { balance: { increment: refundAmount } } });
    await prisma.cardActivity.create({ data: { cardId: card.id, type: "refund", amount: refundAmount, label: `${sub.bundle.nameEn} bundle cancellation refund` } });
  }

  await writeAudit(userId, "fee.bundle.cancelled", { subscriptionId: sub.id, refundable: sub.bundle.refundable, refundAmount });
  if (refundAmount >= 1) {
    await notifyUser(userId, { type: "bundle_cancelled", title: "Bundle cancelled", message: `${sub.bundle.nameEn} cancelled. ${refundAmount.toLocaleString()} TZS refunded to your wallet for unused time.`, url: "/pay" });
  }

  return { refundAmount };
}

/**
 * Auto-renewal — processes every subscription that has expired (past its
 * grace period, if any) with autoRenew=true. Designed to be called
 * periodically (see the in-process scheduler in index.js) or on demand via
 * the admin "run now" endpoint, and is safe to call repeatedly: a
 * subscription is only ever processed once, since it's immediately marked
 * EXPIRED (on failure) or superseded by a new ACTIVE subscription (on
 * success), either way removing it from the next run's query.
 */
async function processBundleRenewals() {
  const now = new Date();
  const dueSubs = await prisma.customerBundleSubscription.findMany({
    where: { status: "ACTIVE", autoRenew: true, expiresAt: { lte: now } },
    include: { bundle: true },
  });

  const results = { renewed: 0, failed: 0, checked: dueSubs.length };

  for (const sub of dueSubs) {
    // Respect a configured grace period before actually expiring/renewing —
    // gives a customer a short window to top up if their balance was low
    // right at expiry.
    const graceMs = (sub.bundle.gracePeriodDays || 0) * 24 * 60 * 60 * 1000;
    if (now.getTime() - new Date(sub.expiresAt).getTime() < graceMs) continue;

    try {
      await purchaseBundleForUser(sub.userId, sub.bundle, { autoRenew: true, isRenewal: true });
      await prisma.customerBundleSubscription.update({ where: { id: sub.id }, data: { status: "EXPIRED" } });
      results.renewed++;
    } catch (err) {
      await prisma.customerBundleSubscription.update({ where: { id: sub.id }, data: { status: "EXPIRED" } });
      await notifyUser(sub.userId, {
        type: "bundle_renewal_failed",
        title: "Bundle renewal failed",
        message: `${sub.bundle.nameEn} couldn't be renewed (${err.message || "insufficient balance"}) and has expired. You can purchase it again any time.`,
        url: "/pay",
      });
      results.failed++;
      console.error(`Bundle renewal failed for subscription ${sub.id}:`, err.message); // eslint-disable-line no-console
    }
  }

  return results;
}

module.exports = { serializeBundle, serializeSubscription, computeExpiry, purchaseBundleForUser, cancelSubscriptionForUser, processBundleRenewals };
