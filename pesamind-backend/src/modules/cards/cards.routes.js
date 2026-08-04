const { Router } = require("express");
const { z } = require("zod");
const crypto = require("crypto");
const prisma = require("../../lib/prisma");
const { requireAuth } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/errorHandler");
const { badRequest } = require("../../lib/errors");
const { getCardFundingProvider } = require("../../services/card-funding");
const { getCardIssuingProvider } = require("../../services/card-issuing");
const { getPaymentRailProvider } = require("../../services/payments-rail");
const { requireKycIfOverThreshold } = require("./kycGate");
const { myCard, debitCard } = require("./cardHelpers");
const { writeAudit } = require("../../lib/audit");
const { checkIdempotencyKey, saveIdempotentResponse } = require("../../lib/idempotency");

const router = Router();
router.use(requireAuth);

router.get(
  "/me",
  asyncHandler(async (req, res) => {
    const card = await myCard(req.userId);
    const activity = await prisma.cardActivity.findMany({ where: { cardId: card.id }, orderBy: { date: "desc" }, take: 50 });
    res.json({ card, activity });
  })
);

router.post(
  "/freeze",
  asyncHandler(async (req, res) => {
    const { frozen } = z.object({ frozen: z.boolean() }).parse(req.body);
    const card = await myCard(req.userId);
    const snapshot = await getCardIssuingProvider().setFrozen(card.id, frozen);
    await writeAudit(req.userId, frozen ? "card.frozen" : "card.unfrozen", { ip: req.ip });
    res.json({ card: snapshot });
  })
);

router.post(
  "/controls",
  asyncHandler(async (req, res) => {
    const controls = z.object({ online: z.boolean(), contactless: z.boolean(), atm: z.boolean() }).parse(req.body);
    const card = await myCard(req.userId);
    const snapshot = await getCardIssuingProvider().setControls(card.id, controls);
    await writeAudit(req.userId, "card.controls.updated", { ip: req.ip, controls });
    res.json({ card: snapshot });
  })
);

router.post(
  "/daily-limit",
  asyncHandler(async (req, res) => {
    const { dailyLimit } = z.object({ dailyLimit: z.number().positive() }).parse(req.body);
    const card = await myCard(req.userId);
    const snapshot = await getCardIssuingProvider().setDailyLimit(card.id, dailyLimit);
    await writeAudit(req.userId, "card.daily_limit.updated", { ip: req.ip, dailyLimit });
    res.json({ card: snapshot });
  })
);

// --- Funding: Visa gateway top-up or Original Credit Transaction push ---
// Both are idempotency-key-guarded and KYC-gated — real money enters the
// system here, so a retried request must never be double-processed.
const fundingInput = z.object({ paymentToken: z.string().min(4), amount: z.number().positive() });

router.post(
  "/topup/gateway",
  asyncHandler(async (req, res) => {
    const existing = await checkIdempotencyKey(req);
    if (existing) return res.status(existing.statusCode).json(existing.responseBody);

    const { paymentToken, amount } = fundingInput.parse(req.body);
    await requireKycIfOverThreshold(req.userId, amount);

    const card = await myCard(req.userId);
    const funding = await getCardFundingProvider().chargeGateway({ paymentToken, amount, currency: "TZS" });
    if (funding.status !== "completed") throw badRequest("Funding did not complete", funding);

    const snapshot = await getCardIssuingProvider().credit(card.id, { type: "topup", amount, label: `Top-up from ${funding.maskedSource}` });
    const body = { card: snapshot, funding };
    await saveIdempotentResponse(req, 200, body);
    await writeAudit(req.userId, "card.topup.gateway", { ip: req.ip, amount, maskedSource: funding.maskedSource });
    res.json(body);
  })
);

router.post(
  "/topup/oct",
  asyncHandler(async (req, res) => {
    const existing = await checkIdempotencyKey(req);
    if (existing) return res.status(existing.statusCode).json(existing.responseBody);

    const { paymentToken, amount } = fundingInput.parse(req.body);
    await requireKycIfOverThreshold(req.userId, amount);

    const card = await myCard(req.userId);
    const funding = await getCardFundingProvider().pushFunds({ paymentToken, amount, currency: "TZS" });
    if (funding.status !== "completed") throw badRequest("Funding did not complete", funding);

    const snapshot = await getCardIssuingProvider().credit(card.id, { type: "oct", amount, label: `Instant push from ${funding.maskedSource}` });
    const body = { card: snapshot, funding };
    await saveIdempotentResponse(req, 200, body);
    await writeAudit(req.userId, "card.topup.oct", { ip: req.ip, amount, maskedSource: funding.maskedSource });
    res.json(body);
  })
);

// --- Payments: Lipa (QR/TIPS), GePG (government bills), LUKU (electricity) ---

router.post(
  "/pay/lipa/resolve",
  asyncHandler(async (req, res) => {
    const { destination } = z.object({ destination: z.string().min(3) }).parse(req.body);
    const recipient = await getPaymentRailProvider().resolveRecipient(destination);
    res.json({ recipient });
  })
);

router.post(
  "/pay/lipa",
  asyncHandler(async (req, res) => {
    const existing = await checkIdempotencyKey(req);
    if (existing) return res.status(existing.statusCode).json(existing.responseBody);

    const { destination, amount, categoryId } = z
      .object({ destination: z.string().min(3), amount: z.number().positive(), categoryId: z.string().min(1) })
      .parse(req.body);
    await requireKycIfOverThreshold(req.userId, amount);

    const card = await myCard(req.userId);
    const rail = getPaymentRailProvider();
    const recipient = await rail.resolveRecipient(destination);
    const payment = await rail.initiatePayment({ destination, amount, currency: "TZS" });
    if (payment.status !== "completed") throw badRequest("Payment did not complete", payment);

    const [snapshot, wallet] = await Promise.all([
      debitCard(card.id, { type: "lipa", amount, label: `Paid to ${recipient.name}` }),
      prisma.walletMember.findFirstOrThrow({ where: { userId: req.userId }, include: { wallet: true } }),
    ]);
    const requester = await prisma.user.findUniqueOrThrow({ where: { id: req.userId } });
    const transaction = await prisma.transaction.create({
      data: {
        walletId: wallet.walletId,
        categoryId,
        amount: -Math.abs(amount),
        merchant: recipient.name,
        date: new Date(),
        loggedByUserId: req.userId,
        loggedByName: requester.firstName,
        source: "lipa",
      },
    });
    const body = { card: snapshot, transaction, payment };
    await saveIdempotentResponse(req, 200, body);
    await writeAudit(req.userId, "card.pay.lipa", { ip: req.ip, amount, destination, merchant: recipient.name });
    res.json(body);
  })
);

router.post(
  "/pay/gepg",
  asyncHandler(async (req, res) => {
    const existing = await checkIdempotencyKey(req);
    if (existing) return res.status(existing.statusCode).json(existing.responseBody);

    const { control, amount, biller, categoryId } = z
      .object({ control: z.string().min(6), amount: z.number().positive(), biller: z.string().min(1), categoryId: z.string().min(1) })
      .parse(req.body);
    await requireKycIfOverThreshold(req.userId, amount);

    const card = await myCard(req.userId);
    const snapshot = await debitCard(card.id, { type: "gepg", amount, label: biller, sub: `Control No. ${control}` });
    const wallet = await prisma.walletMember.findFirstOrThrow({ where: { userId: req.userId } });
    const requester = await prisma.user.findUniqueOrThrow({ where: { id: req.userId } });
    const transaction = await prisma.transaction.create({
      data: { walletId: wallet.walletId, categoryId, amount: -Math.abs(amount), merchant: biller, date: new Date(), loggedByUserId: req.userId, loggedByName: requester.firstName, source: "gepg" },
    });
    const body = { card: snapshot, transaction };
    await saveIdempotentResponse(req, 200, body);
    await writeAudit(req.userId, "card.pay.gepg", { ip: req.ip, amount, control, biller });
    res.json(body);
  })
);

router.post(
  "/pay/luku",
  asyncHandler(async (req, res) => {
    const existing = await checkIdempotencyKey(req);
    if (existing) return res.status(existing.statusCode).json(existing.responseBody);

    const { meter, amount, categoryId } = z
      .object({ meter: z.string().min(6), amount: z.number().positive(), categoryId: z.string().min(1) })
      .parse(req.body);
    await requireKycIfOverThreshold(req.userId, amount);

    const card = await myCard(req.userId);
    const snapshot = await debitCard(card.id, { type: "luku", amount, label: `Meter ${meter}` });
    const token = Array.from({ length: 4 }, () => crypto.randomInt(1000, 9999)).join("-");
    const wallet = await prisma.walletMember.findFirstOrThrow({ where: { userId: req.userId } });
    const requester = await prisma.user.findUniqueOrThrow({ where: { id: req.userId } });
    const transaction = await prisma.transaction.create({
      data: { walletId: wallet.walletId, categoryId, amount: -Math.abs(amount), merchant: `LUKU Meter ${meter}`, date: new Date(), loggedByUserId: req.userId, loggedByName: requester.firstName, source: "luku" },
    });
    const body = { card: snapshot, transaction, token };
    await saveIdempotentResponse(req, 200, body);
    await writeAudit(req.userId, "card.pay.luku", { ip: req.ip, amount, meter });
    res.json(body);
  })
);

module.exports = router;
