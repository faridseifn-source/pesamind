const { Router } = require("express");
const { z } = require("zod");
const prisma = require("../../lib/prisma");
const { requireAuth } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/errorHandler");
const { notFound, badRequest, conflict } = require("../../lib/errors");
const { writeAudit } = require("../../lib/audit");
const { notifyUser } = require("../../lib/notify");
const { myCard, debitCard } = require("../cards/cardHelpers");

const router = Router();
router.use(requireAuth);

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

// GET /fees/bundles — every bundle a customer could currently purchase.
// Shows price, validity, included services, and limits up front — the
// spec's "display terms before purchase" requirement — before any purchase
// action, not after.
router.get(
  "/bundles",
  asyncHandler(async (req, res) => {
    const now = new Date();
    const bundles = await prisma.feeBundle.findMany({
      where: {
        isActive: true,
        OR: [{ startDate: null }, { startDate: { lte: now } }],
        AND: [{ OR: [{ endDate: null }, { endDate: { gte: now } }] }],
      },
      orderBy: { price: "asc" },
    });
    res.json({ bundles: bundles.map(serializeBundle) });
  })
);

// GET /fees/bundles/my — the customer's own subscriptions (active, expired,
// cancelled), most recent first.
router.get(
  "/bundles/my",
  asyncHandler(async (req, res) => {
    const subs = await prisma.customerBundleSubscription.findMany({
      where: { userId: req.userId },
      include: { bundle: true },
      orderBy: { purchasedAt: "desc" },
    });
    res.json({ subscriptions: subs.map(serializeSubscription) });
  })
);

router.post(
  "/bundles/:id/purchase",
  asyncHandler(async (req, res) => {
    const bundle = await prisma.feeBundle.findUnique({ where: { id: req.params.id } });
    if (!bundle || !bundle.isActive) throw notFound("This bundle isn't available");

    const now = new Date();
    if (bundle.startDate && bundle.startDate > now) throw badRequest("This bundle isn't available yet");
    if (bundle.endDate && bundle.endDate < now) throw badRequest("This bundle is no longer available");

    // One active subscription per bundle at a time — keeps "did this
    // purchase actually renew or double-stack" unambiguous. A customer who
    // wants to keep using it renews after expiry, or the bundle's own
    // autoRenew setting handles it (see the renewal note in FEE_ENGINE.md —
    // automatic renewal billing isn't wired yet, tracked as a known gap).
    const existingActive = await prisma.customerBundleSubscription.findFirst({
      where: { userId: req.userId, bundleId: bundle.id, status: "ACTIVE", expiresAt: { gte: now } },
    });
    if (existingActive) throw conflict("You already have an active subscription to this bundle");

    const price = Number(bundle.price);
    const card = await myCard(req.userId);
    if (Number(card.balance) < price) throw badRequest(`This bundle costs ${price.toLocaleString()} TZS — please top up first`);

    await debitCard(card.id, { type: "bundle_purchase", amount: price, label: `${bundle.nameEn} bundle` });

    const subscription = await prisma.customerBundleSubscription.create({
      data: {
        userId: req.userId, bundleId: bundle.id, expiresAt: computeExpiry(bundle.validity, now),
        pricePaid: price, autoRenew: bundle.autoRenewDefault,
      },
      include: { bundle: true },
    });

    await writeAudit(req.userId, "fee.bundle.purchased", { ip: req.ip, bundleId: bundle.id, subscriptionId: subscription.id, price });
    await notifyUser(req.userId, { type: "bundle_purchased", title: "Bundle activated", message: `${bundle.nameEn} is active until ${subscription.expiresAt.toLocaleDateString()}.`, url: "/pay" });

    res.status(201).json({ subscription: serializeSubscription(subscription) });
  })
);

router.post(
  "/bundles/subscriptions/:id/cancel",
  asyncHandler(async (req, res) => {
    const sub = await prisma.customerBundleSubscription.findUnique({ where: { id: req.params.id }, include: { bundle: true } });
    if (!sub || sub.userId !== req.userId) throw notFound("Subscription not found");
    if (sub.status !== "ACTIVE") throw badRequest("This subscription isn't active");
    if (!sub.bundle.cancellable) throw badRequest("This bundle can't be cancelled once purchased");

    // Refund policy is admin-configured per bundle (spec Section 6) — this
    // marks the subscription cancelled either way; whether/how much comes
    // back to the wallet for a refundable bundle is a deliberate manual
    // step for an admin today (via a support ticket), not automated here,
    // since it needs a human judgment call on usage-so-far. Tracked as a
    // known gap in FEE_ENGINE.md.
    await prisma.customerBundleSubscription.update({ where: { id: sub.id }, data: { status: "CANCELLED" } });
    await writeAudit(req.userId, "fee.bundle.cancelled", { ip: req.ip, subscriptionId: sub.id, refundable: sub.bundle.refundable });

    res.json({ success: true, refundable: sub.bundle.refundable });
  })
);

module.exports = router;
