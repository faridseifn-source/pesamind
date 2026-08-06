const { Router } = require("express");
const { z } = require("zod");
const rateLimit = require("express-rate-limit");
const prisma = require("../../lib/prisma");
const { requireAuth } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/errorHandler");
const { checkIdempotencyKey, saveIdempotentResponse } = require("../../lib/idempotency");
const { resolveQrPayload, payViaQr, getPaymentStatus } = require("./qrPayment.service");
const { computeCrc16 } = require("../../lib/tanqr");
const { getSetting } = require("../../lib/settings");

const router = Router();
router.use(requireAuth);

// Scanning/resolving is deliberately not idempotency-gated (it moves no
// money) but is rate-limited — a malformed-payload retry loop shouldn't be
// able to hammer the parser.
const scanLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });

// POST /qr/resolve { payload } — parse + validate a scanned QR and return
// merchant details for display before confirmation. No money moves here.
router.post(
  "/resolve",
  scanLimiter,
  asyncHandler(async (req, res) => {
    const { payload } = z.object({ payload: z.string().min(10) }).parse(req.body);
    const { parsed, merchant, isOnUs } = await resolveQrPayload(payload);
    res.json({
      merchant: { id: merchant.id, name: merchant.name, city: merchant.city, mcc: merchant.mcc },
      isOnUs,
      pointOfInitiationMethod: parsed.pointOfInitiationMethod,
      amount: parsed.amount, // null if the customer needs to enter one
      amountFixed: parsed.amountFixed,
      currency: "TZS",
    });
  })
);

// POST /qr/pay — the full customer journey from confirmed payment through
// to settlement. Requires an Idempotency-Key so a retried tap (or a flaky
// connection) can never double-debit.
router.post(
  "/pay",
  asyncHandler(async (req, res) => {
    const existing = await checkIdempotencyKey(req);
    if (existing) return res.status(existing.statusCode).json(existing.responseBody);

    const { payload, cardType, cardId, amount, categoryId, authMethod } = z
      .object({
        payload: z.string().min(10),
        cardType: z.enum(["main", "virtual"]),
        cardId: z.string().min(1),
        amount: z.number().positive().optional(), // required only when the QR doesn't fix one
        categoryId: z.string().min(1),
        authMethod: z.enum(["pin", "biometric", "otp"]),
      })
      .parse(req.body);

    const { payment } = await payViaQr({ userId: req.userId, rawPayload: payload, cardType, cardId, amountOverride: amount, categoryId, authMethod });

    const body = { payment: serializePayment(payment) };
    await saveIdempotentResponse(req, 200, body);
    res.json(body);
  })
);

// GET /qr/payments/:reference — status enquiry (Requirement: "transaction-
// status enquiries"), including the full per-stage event history.
router.get(
  "/payments/:reference",
  asyncHandler(async (req, res) => {
    const payment = await getPaymentStatus(req.params.reference, req.userId);
    res.json({
      payment: serializePayment(payment),
      merchant: payment.merchant ? { name: payment.merchant.name, city: payment.merchant.city } : undefined,
      events: payment.events?.map((e) => ({ stage: e.stage, outcome: e.outcome, createdAt: e.createdAt })),
    });
  })
);

// GET /qr/payments — the customer's own QR payment history.
router.get(
  "/payments",
  asyncHandler(async (req, res) => {
    const payments = await prisma.qrPayment.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { merchant: { select: { name: true, city: true } } },
    });
    res.json({ payments: payments.map((p) => ({ ...serializePayment(p), merchantName: p.merchant.name, merchantCity: p.merchant.city })) });
  })
);

function serializePayment(p) {
  return {
    id: p.id,
    reference: p.reference,
    amount: Number(p.amount),
    currency: p.currency,
    isOnUs: p.isOnUs,
    status: p.status,
    stage: p.stage,
    failureReason: p.failureReason,
    reversalReason: p.reversalReason,
    createdAt: p.createdAt,
    completedAt: p.completedAt,
  };
}

function buildTag(tag, value) {
  return `${tag}${String(value.length).padStart(2, "0")}${value}`;
}

// Builds a spec-valid TANQR payload string, using the same CRC
// implementation the parser validates against — so a "sample" QR here is
// exactly as real, from the parser's point of view, as a scanned one.
function buildSamplePayload({ acquirerId, merchantId, merchantName, city, mcc, amount }) {
  const merchantAccountInfo = buildTag("00", "tz.go.bot.tips") + buildTag("01", acquirerId) + buildTag("02", merchantId);
  let body =
    buildTag("00", "01") +
    buildTag("01", "12") + // dynamic, since we're generating a specific sample each time
    buildTag("26", merchantAccountInfo) +
    buildTag("52", mcc || "5999") +
    buildTag("53", "834") +
    (amount ? buildTag("54", String(amount)) : "") +
    buildTag("58", "TZ") +
    buildTag("59", merchantName) +
    buildTag("60", city || "DAR ES SALAAM");
  body += "6304";
  const crc = computeCrc16(body);
  return body + crc;
}

// GET /qr/dev/sample-payloads — generates one on-us and one off-us sample
// payload for testing the full flow without a real merchant QR code. Moves
// no money and creates no records; purely a payload-construction helper.
router.get(
  "/dev/sample-payloads",
  asyncHandler(async (req, res) => {
    const partnerAcquirerId = await getSetting("partner_bank_acquirer_id");
    const onUs = buildSamplePayload({ acquirerId: partnerAcquirerId, merchantId: "10023456", merchantName: "PESAMIND CAFE", city: "DAR ES SALAAM", mcc: "5814", amount: null });
    const offUsAcquirerId = partnerAcquirerId === "01002" ? "01003" : "01002";
    const offUs = buildSamplePayload({ acquirerId: offUsAcquirerId, merchantId: "20098765", merchantName: "KARIAKOO MARKET STALL 12", city: "DAR ES SALAAM", mcc: "5399", amount: 15000 });
    res.json({
      onUs: { payload: onUs, description: "On-us sample — settles directly through the partner bank's CBS" },
      offUs: { payload: offUs, description: "Off-us sample — routes through TIPS, fixed amount of TZS 15,000" },
    });
  })
);

module.exports = router;
