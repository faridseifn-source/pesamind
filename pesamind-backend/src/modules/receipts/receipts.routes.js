const { Router } = require("express");
const { z } = require("zod");
const rateLimit = require("express-rate-limit");
const prisma = require("../../lib/prisma");
const { requireAuth } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/errorHandler");
const { forbidden, badRequest } = require("../../lib/errors");
const { getSetting } = require("../../lib/settings");
const { getOcrProvider } = require("../../services/ocr");
const { convertToPreferredCurrency } = require("../../lib/currencyConversion");
const { writeAudit } = require("../../lib/audit");

const router = Router();
router.use(requireAuth);

// Genuine external API calls cost real money per request (when a real
// provider is configured) — rate limit against accidental hammering
// (e.g. a client-side retry loop) separately from the general API limits.
const scanLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });

// POST /receipts/scan { imageBase64, mimeType } — extracts merchant,
// amount, currency, date, and a best-fit category from a receipt photo.
// If the receipt was in a different currency than the customer's
// preferredCurrency, converts the amount automatically and discloses the
// conversion (original amount, original currency, rate used) rather than
// silently presenting a converted number as if it were what the receipt
// actually said. Never falls back to placeholder data on failure or when
// disabled — either returns a real extraction, or a clear "unavailable"/
// "couldn't read this" signal for the client to route to manual entry.
router.post(
  "/scan",
  scanLimiter,
  asyncHandler(async (req, res) => {
    const enabled = (await getSetting("receipt_ocr_enabled")) !== "false";
    if (!enabled) throw forbidden("Receipt scanning is currently turned off — please add this expense manually.");

    const { imageBase64, mimeType } = z.object({
      imageBase64: z.string().min(100), // a real photo is always far larger than this; guards against an empty/near-empty payload
      mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
    }).parse(req.body);

    const [categories, user] = await Promise.all([
      prisma.category.findMany({ where: { OR: [{ userId: null }, { userId: req.userId }] }, select: { name: true } }),
      prisma.user.findUnique({ where: { id: req.userId }, select: { preferredCurrency: true } }),
    ]);
    const categoryNames = categories.map((c) => c.name);
    const preferredCurrency = user.preferredCurrency;

    let result;
    try {
      result = await getOcrProvider().extractReceipt({ imageBase64, mimeType, categoryNames });
    } catch (err) {
      console.error("Receipt OCR extraction failed:", err.message); // eslint-disable-line no-console
      throw badRequest("We couldn't read this receipt. Please try a clearer photo, or add this expense manually.");
    }

    let converted = { amount: result.amount, originalAmount: null, originalCurrency: null, exchangeRate: null };
    let conversionFailed = false;
    if (result.amount !== null && result.currency && result.currency !== preferredCurrency) {
      try {
        converted = await convertToPreferredCurrency({ amount: result.amount, currency: result.currency, preferredCurrency });
      } catch (err) {
        // The extraction itself succeeded — don't throw away a real read
        // just because the conversion step failed. Surface the original,
        // unconverted amount and let the customer confirm the TZS
        // equivalent themselves, with a clear flag on why.
        console.error("Currency conversion failed after successful OCR:", err.message); // eslint-disable-line no-console
        conversionFailed = true;
      }
    }

    await writeAudit(req.userId, "receipt.scanned", {
      ip: req.ip, merchantExtracted: !!result.merchant, confidence: result.confidence,
      originalCurrency: result.currency, converted: !!converted.originalCurrency,
    });

    res.json({
      merchant: result.merchant,
      amount: converted.amount,
      currency: preferredCurrency,
      originalAmount: converted.originalAmount,
      originalCurrency: converted.originalCurrency,
      exchangeRate: converted.exchangeRate,
      conversionFailed,
      date: result.date,
      category: result.category,
      confidence: result.confidence,
    });
  })
);

module.exports = router;
