const crypto = require("crypto");
const prisma = require("../../lib/prisma");
const { parseTanqrPayload, buildAliasMerchantId, parseAliasMerchantId } = require("../../lib/tanqr");
const { getSetting } = require("../../lib/settings");
const { getCbsProvider } = require("../../services/cbs");
const { getTipsProvider } = require("../../services/tips");
const { myCard, debitCard } = require("../cards/cardHelpers");
const { getCardIssuingProvider } = require("../../services/card-issuing");
const { writeAudit } = require("../../lib/audit");
const { badRequest, notFound, forbidden } = require("../../lib/errors");
const { requireKycIfOverThreshold } = require("../cards/kycGate");
const { notifyUser } = require("../../lib/notify");

function generateReference() {
  return `QR-${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
}

async function logEvent(paymentId, stage, outcome, detail) {
  await prisma.qrPaymentEvent.create({ data: { paymentId, stage, outcome, detail: detail ?? undefined } });
}

// Parses + validates a scanned QR and identifies the merchant, without
// moving any money — powers "display merchant details before confirmation."
async function resolveQrPayload(rawPayload) {
  const parsed = parseTanqrPayload(rawPayload); // throws a customer-safe message on any spec violation

  const partnerAcquirerId = await getSetting("partner_bank_acquirer_id");
  const isOnUs = parsed.acquirerId === partnerAcquirerId;
  const aliasMerchantId = buildAliasMerchantId(parsed.acquirerId, parsed.merchantId);

  const merchant = await prisma.merchant.upsert({
    where: { acquirerId_merchantId: { acquirerId: parsed.acquirerId, merchantId: parsed.merchantId } },
    update: { name: parsed.merchantName, city: parsed.merchantCity, mcc: parsed.mcc, isOnUs, aliasMerchantId },
    create: { acquirerId: parsed.acquirerId, merchantId: parsed.merchantId, name: parsed.merchantName, city: parsed.merchantCity, mcc: parsed.mcc, isOnUs, aliasMerchantId },
  });

  return { parsed, merchant, isOnUs };
}

// Manual entry path (Requirement: "manual entry of merchant... following
// the TIPS standard") — the customer types the 8-digit TIPS Alias Merchant
// ID (TANQR Annex 3 §2) instead of scanning. Only resolves merchants
// already known to our registry (from a prior scan or admin seeding) —
// a real deployment would ask TIPS itself to resolve an unknown alias;
// we're simulating that resolution against our own cache. No amount is
// carried by an alias, so the customer always enters one afterward.
async function resolveByAlias(aliasMerchantId) {
  parseAliasMerchantId(aliasMerchantId); // validates format + Damm checksum, throws a customer-safe message
  const merchant = await prisma.merchant.findFirst({ where: { aliasMerchantId } });
  if (!merchant) throw notFound("We don't recognize that merchant number yet — try scanning their QR code instead");
  return { merchant, isOnUs: merchant.isOnUs };
}

async function loadDebitableCard({ cardType, cardId, userId }) {
  if (cardType === "virtual") {
    const card = await prisma.virtualCard.findUnique({ where: { id: cardId } });
    if (!card) throw notFound("Card not found");
    if (card.holderId !== userId) throw forbidden("You don't have access to this card");
    if (card.terminated) throw badRequest("This card has been terminated");
    if (card.frozen) throw badRequest("This card is frozen");
    return card;
  }
  const card = await myCard(userId);
  if (card.frozen) throw badRequest("Your card is frozen");
  return card;
}

async function debitWallet({ cardType, cardId, userId, amount, label }) {
  if (cardType === "virtual") {
    const card = await prisma.virtualCard.findUnique({ where: { id: cardId } });
    if (Number(card.balance) < amount) throw badRequest("Insufficient card balance");
    await prisma.virtualCard.update({ where: { id: cardId }, data: { balance: { decrement: amount } } });
    await prisma.virtualCardActivity.create({ data: { cardId, type: "spend", amount, label, performedByUserId: userId } });
    return;
  }
  const mainCard = await myCard(userId);
  await debitCard(mainCard.id, { type: "qr_payment", amount, label }); // throws a clean 400 on insufficient funds
}

async function creditWalletBack({ cardType, cardId, userId, amount, label }) {
  if (cardType === "virtual") {
    await prisma.virtualCard.update({ where: { id: cardId }, data: { balance: { increment: amount } } });
    await prisma.virtualCardActivity.create({ data: { cardId, type: "topup", amount, label, performedByUserId: userId } });
    return;
  }
  const mainCard = await myCard(userId);
  await getCardIssuingProvider().credit(mainCard.id, { type: "reversal", amount, label });
}

async function resolveWalletId({ cardType, cardId, userId }) {
  if (cardType === "virtual") {
    const card = await prisma.virtualCard.findUniqueOrThrow({ where: { id: cardId } });
    return card.walletId;
  }
  const membership = await prisma.walletMember.findFirstOrThrow({ where: { userId, wallet: { type: "PERSONAL" } } });
  return membership.walletId;
}

// Posts the real ledger Transaction and marks the QrPayment completed —
// the only point at which either happens. Safe to call from the pending-
// resolution path too, since everything it needs is already on `payment`.
async function completePaymentFromRecord(payment, merchantName) {
  const walletId = await resolveWalletId({
    cardType: payment.cardId ? "main" : "virtual",
    cardId: payment.cardId || payment.virtualCardId,
    userId: payment.userId,
  });
  const requester = await prisma.user.findUniqueOrThrow({ where: { id: payment.userId } });
  const transaction = await prisma.transaction.create({
    data: {
      walletId, categoryId: payment.categoryId, amount: -Math.abs(Number(payment.amount)), merchant: merchantName, date: new Date(),
      loggedByUserId: payment.userId, loggedByName: requester.firstName, source: "qr_payment", reference: payment.reference, status: "completed",
    },
  });
  await prisma.qrPayment.update({ where: { id: payment.id }, data: { status: "completed", stage: "completed", completedAt: new Date(), transactionId: transaction.id } });
  await logEvent(payment.id, "completed", "success", { transactionId: transaction.id });
  await writeAudit(payment.userId, "qrpayment.completed", { paymentId: payment.id, reference: payment.reference, amount: Number(payment.amount) });
  await notifyUser(payment.userId, {
    type: "qr_payment_completed",
    title: "Payment successful",
    message: `You paid ${merchantName} — reference ${payment.reference}`,
    url: "/pay",
  });
  return transaction;
}

/**
 * Runs the full customer journey from a validated, confirmed payment
 * request through to settlement — steps 2-7 of the on-us flow, or 2-10 of
 * the off-us flow, as one controlled lifecycle (Requirement 4). The wallet
 * is only ever left debited if CBS/TIPS ultimately confirm success;
 * anything else triggers an automatic reversal before returning.
 */
async function payViaQr({ userId, rawPayload, aliasMerchantId, cardType, cardId, amountOverride, categoryId, authMethod }) {
  const { merchant, isOnUs, parsed } = rawPayload
    ? await resolveQrPayload(rawPayload)
    : await resolveByAlias(aliasMerchantId);
  // An alias carries no fixed amount and no point-of-initiation method — the
  // customer always enters the amount themselves for a manually-keyed payment.
  const amount = parsed?.amountFixed ? parsed.amount : amountOverride;
  const storedPayload = rawPayload || `ALIAS:${aliasMerchantId}`;
  const pointOfInitiationMethod = parsed?.pointOfInitiationMethod || "manual_alias";
  if (!amount || amount <= 0) throw badRequest("Enter a valid amount to pay");
  if (!categoryId) throw badRequest("Select a category for this payment");

  await requireKycIfOverThreshold(userId, amount);
  const card = await loadDebitableCard({ cardType, cardId, userId });
  if (Number(card.balance) < amount) throw badRequest("Insufficient card balance");

  const reference = generateReference();
  const payment = await prisma.qrPayment.create({
    data: {
      userId, reference, merchantId: merchant.id, pointOfInitiationMethod,
      rawPayload: storedPayload, currency: "TZS", amount, isOnUs, categoryId,
      cardId: cardType === "main" ? card.id : null, virtualCardId: cardType === "virtual" ? card.id : null,
      authMethod, status: "processing", stage: "initiated",
    },
  });
  await logEvent(payment.id, "initiated", "success", { reference, isOnUs, acquirerId: merchant.acquirerId, merchantId: merchant.merchantId, viaAlias: !rawPayload });

  const reversePayment = async (stage, reason) => {
    await creditWalletBack({ cardType, cardId: card.id, userId, amount, label: `Reversal: ${merchant.name}` });
    await prisma.qrPayment.update({ where: { id: payment.id }, data: { status: "reversed", stage, reversedAt: new Date(), reversalReason: reason } });
    await logEvent(payment.id, "reversed", "success", { reason });
    await writeAudit(userId, "qrpayment.reversed", { paymentId: payment.id, reference, reason });
    await notifyUser(userId, {
      type: "qr_payment_reversed",
      title: "Payment reversed",
      message: `Your payment to ${merchant.name} couldn't be completed and has been refunded to your wallet.`,
      url: "/pay",
    });
  };

  // Step: hold/debit the customer's prepaid-wallet balance
  try {
    await debitWallet({ cardType, cardId: card.id, userId, amount, label: `Paid ${merchant.name}` });
  } catch (err) {
    await prisma.qrPayment.update({ where: { id: payment.id }, data: { status: "failed", stage: "wallet_held", failureReason: err.message } });
    await logEvent(payment.id, "wallet_held", "failed", { reason: err.message });
    throw err;
  }
  await prisma.qrPayment.update({ where: { id: payment.id }, data: { stage: "wallet_held" } });
  await logEvent(payment.id, "wallet_held", "success", { amount });

  // Step: post the wallet-side movement in the partner bank's CBS
  const cbs = getCbsProvider();
  const settlementResult = await cbs.debitSettlementAccount({ reference, amount, narrative: `QR payment ${reference}`, paymentId: payment.id });
  if (settlementResult.status !== "posted") {
    await logEvent(payment.id, "cbs_posted", "failed", settlementResult);
    await reversePayment("cbs_posted", settlementResult.failureReason || "CBS posting failed");
    return { payment: await prisma.qrPayment.findUnique({ where: { id: payment.id } }) };
  }
  await prisma.qrPayment.update({ where: { id: payment.id }, data: { stage: "settlement_debited", cbsPostingRef: settlementResult.cbsRef } });
  await logEvent(payment.id, "settlement_debited", "success", settlementResult);

  if (isOnUs) {
    // On-us: credit the merchant's account directly in CBS.
    const creditResult = await cbs.creditMerchantAccount({ reference, merchantAccountRef: merchant.merchantId, amount, narrative: `QR payment ${reference}`, paymentId: payment.id });
    if (creditResult.status !== "posted") {
      await logEvent(payment.id, "merchant_credited", "failed", creditResult);
      await cbs.reverse(settlementResult.cbsRef, "merchant credit failed");
      await reversePayment("merchant_credited", creditResult.failureReason || "Couldn't credit the merchant");
      return { payment: await prisma.qrPayment.findUnique({ where: { id: payment.id } }) };
    }
    await logEvent(payment.id, "merchant_credited", "success", creditResult);
    const fresh = await prisma.qrPayment.findUniqueOrThrow({ where: { id: payment.id } });
    await completePaymentFromRecord(fresh, merchant.name);
  } else {
    // Off-us: debit to the TIPS transit account, then route through TIPS.
    const transitResult = await cbs.debitToTipsTransitAccount({ reference, amount, narrative: `QR payment ${reference} via TIPS`, paymentId: payment.id });
    if (transitResult.status !== "posted") {
      await logEvent(payment.id, "tips_initiated", "failed", transitResult);
      await cbs.reverse(settlementResult.cbsRef, "TIPS transit debit failed");
      await reversePayment("tips_initiated", transitResult.failureReason || "Couldn't route to TIPS");
      return { payment: await prisma.qrPayment.findUnique({ where: { id: payment.id } }) };
    }
    await logEvent(payment.id, "tips_initiated", "success", transitResult);

    const tips = getTipsProvider();
    const tipsResult = await tips.routePayment({ reference, acquirerId: merchant.acquirerId, merchantId: merchant.merchantId, amount, currency: "TZS", paymentId: payment.id });
    await prisma.qrPayment.update({ where: { id: payment.id }, data: { tipsInstructionRef: tipsResult.tipsRef, stage: "tips_routed" } });
    await logEvent(payment.id, "tips_routed", tipsResult.status === "completed" ? "success" : tipsResult.status, tipsResult);

    if (tipsResult.status === "completed") {
      const fresh = await prisma.qrPayment.findUniqueOrThrow({ where: { id: payment.id } });
      await completePaymentFromRecord(fresh, merchant.name);
    } else if (tipsResult.status === "pending") {
      await prisma.qrPayment.update({ where: { id: payment.id }, data: { stage: "awaiting_acquirer_response" } });
      await logEvent(payment.id, "awaiting_acquirer_response", "pending", {});
      // Stays "processing" — resolved later via getPaymentStatus's
      // pending-resolution path below (Requirement: "pending-transaction
      // management where the final response is delayed").
    } else {
      await cbs.reverse(settlementResult.cbsRef, "TIPS routing failed");
      await cbs.reverse(transitResult.cbsRef, "TIPS routing failed");
      await reversePayment("tips_routed", tipsResult.failureReason || "Payment could not be routed through TIPS");
      return { payment: await prisma.qrPayment.findUnique({ where: { id: payment.id } }) };
    }
  }

  return { payment: await prisma.qrPayment.findUnique({ where: { id: payment.id } }) };
}

// Status enquiry (Requirement: "transaction-status enquiries"). For a
// payment still awaiting TIPS's final response, resolves it if enough time
// has passed — simulating TIPS eventually answering, since our mock
// resolves synchronously and would otherwise never leave "pending" on its
// own. A real integration replaces this timer with acting on TIPS's actual
// async response (webhook or poll).
async function getPaymentStatus(reference, userId) {
  const payment = await prisma.qrPayment.findUnique({ where: { reference }, include: { merchant: true, events: { orderBy: { createdAt: "asc" } } } });
  if (!payment || payment.userId !== userId) throw notFound("Payment not found");

  if (payment.stage === "awaiting_acquirer_response" && payment.status === "processing") {
    const ageMs = Date.now() - new Date(payment.updatedAt).getTime();
    if (ageMs > 30_000) {
      await completePaymentFromRecord(payment, payment.merchant.name);
      return getPaymentStatus(reference, userId);
    }
  }

  return payment;
}

module.exports = { resolveQrPayload, resolveByAlias, payViaQr, getPaymentStatus, generateReference };
