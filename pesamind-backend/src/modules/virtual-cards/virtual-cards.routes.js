const { Router } = require("express");
const { z } = require("zod");
const prisma = require("../../lib/prisma");
const { requireAuth } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/errorHandler");
const { notFound, forbidden, badRequest } = require("../../lib/errors");
const { writeAudit } = require("../../lib/audit");
const { checkIdempotencyKey, saveIdempotentResponse } = require("../../lib/idempotency");
const { myCard, debitCard } = require("../cards/cardHelpers");
const { getCardIssuingProvider } = require("../../services/card-issuing");

const router = Router();
router.use(requireAuth);

/* --------------------------- permission helpers -------------------------- */

async function loadCard(cardId) {
  const card = await prisma.virtualCard.findUnique({ where: { id: cardId } });
  if (!card) throw notFound("Virtual card not found");
  return card;
}
// Requirement: "All funding and card-management rights must remain with the
// primary member" — every mutating action except spend is owner-only.
function assertOwner(card, userId) {
  if (card.ownerId !== userId) throw forbidden("Only the card's primary member can do this");
}
// Requirement: the child holder "may view the virtual card details and
// transaction history" — owner or holder, read-only actions.
function assertOwnerOrHolder(card, userId) {
  if (card.ownerId !== userId && card.holderId !== userId) throw forbidden("You don't have access to this card");
}
// Only the holder actually spends with the card — including on a
// parent-linked card, where the owner is a different person entirely.
function assertHolder(card, userId) {
  if (card.holderId !== userId) throw forbidden("Only the card holder can spend with this card");
}

function genLast4() {
  return String(1000 + Math.floor(Math.random() * 9000));
}

function serializeCard(card, forUserId) {
  return {
    id: card.id,
    walletId: card.walletId,
    ownerId: card.ownerId,
    holderId: card.holderId,
    type: card.type,
    label: card.label,
    last4: card.last4,
    expiry: card.expiry,
    frozen: card.frozen,
    terminated: card.terminated,
    dailyLimit: Number(card.dailyLimit),
    allowedCategoryIds: card.allowedCategoryIds,
    controls: card.controls,
    services: card.services,
    balance: Number(card.balance),
    myRole: card.ownerId === forUserId ? "owner" : "holder", // both if same person (independent card) — "owner" wins for display
    createdAt: card.createdAt,
  };
}

/* --------------------------------- create --------------------------------- */

// POST /virtual-cards/parent-linked { walletId, holderUserId, label? }
// Requirement 1: only the primary (owner) member of a SHARED wallet can
// issue a card linked to that wallet, to a fellow member of it.
router.post(
  "/parent-linked",
  asyncHandler(async (req, res) => {
    const { walletId, holderUserId, label } = z
      .object({ walletId: z.string().min(1), holderUserId: z.string().min(1), label: z.string().max(40).optional() })
      .parse(req.body);

    const wallet = await prisma.wallet.findUnique({ where: { id: walletId }, include: { members: true } });
    if (!wallet) throw notFound("Wallet not found");
    if (wallet.type !== "SHARED") throw badRequest("Parent-linked cards can only be issued on a shared wallet");
    const requester = wallet.members.find((m) => m.userId === req.userId);
    if (!requester || requester.role !== "owner") throw forbidden("Only the wallet's primary member can issue a linked card");
    if (holderUserId === req.userId) throw badRequest("Use the independent-card endpoint to create your own card");
    const holderMembership = wallet.members.find((m) => m.userId === holderUserId);
    if (!holderMembership) throw badRequest("That person must be a member of this wallet first — invite them via /wallets/:id/invite");

    const existing = await prisma.virtualCard.findFirst({ where: { walletId, ownerId: req.userId, holderId: holderUserId, terminated: false } });
    if (existing) throw badRequest("An active card is already issued to this member on this wallet");

    const card = await prisma.virtualCard.create({
      data: {
        walletId,
        ownerId: req.userId,
        holderId: holderUserId,
        type: "parent_linked",
        label: label || null,
        last4: genLast4(),
        expiry: "09/29",
      },
    });
    await writeAudit(req.userId, "virtualcard.created.parent_linked", { ip: req.ip, walletId, holderUserId, cardId: card.id });
    await prisma.notification.create({
      data: { userId: holderUserId, type: "virtual_card_issued", title: "New virtual card", message: "A virtual card has been issued to you." },
    });

    res.status(201).json({ card: serializeCard(card, req.userId) });
  })
);

// POST /virtual-cards/independent { label? }
// Requirement 2: any user can create their own card, linked exclusively to
// their own personal wallet, controlled solely by themselves.
router.post(
  "/independent",
  asyncHandler(async (req, res) => {
    const { label } = z.object({ label: z.string().max(40).optional() }).parse(req.body);

    const personalMembership = await prisma.walletMember.findFirst({
      where: { userId: req.userId, wallet: { type: "PERSONAL" } },
    });
    if (!personalMembership) throw notFound("No personal wallet found for this account");

    const card = await prisma.virtualCard.create({
      data: {
        walletId: personalMembership.walletId,
        ownerId: req.userId,
        holderId: req.userId,
        type: "independent",
        label: label || null,
        last4: genLast4(),
        expiry: "09/29",
      },
    });
    await writeAudit(req.userId, "virtualcard.created.independent", { ip: req.ip, cardId: card.id });

    res.status(201).json({ card: serializeCard(card, req.userId) });
  })
);

/* ---------------------------------- read ----------------------------------- */

// GET /virtual-cards — every card I own and/or hold.
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const cards = await prisma.virtualCard.findMany({
      where: { OR: [{ ownerId: req.userId }, { holderId: req.userId }] },
      orderBy: { createdAt: "desc" },
    });
    res.json({ cards: cards.map((c) => serializeCard(c, req.userId)) });
  })
);

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const card = await loadCard(req.params.id);
    assertOwnerOrHolder(card, req.userId);
    res.json({ card: serializeCard(card, req.userId) });
  })
);

router.get(
  "/:id/activity",
  asyncHandler(async (req, res) => {
    const card = await loadCard(req.params.id);
    assertOwnerOrHolder(card, req.userId);
    const activity = await prisma.virtualCardActivity.findMany({ where: { cardId: card.id }, orderBy: { date: "desc" }, take: 100 });
    res.json({ activity: activity.map((a) => ({ ...a, amount: a.amount === null ? null : Number(a.amount) })) });
  })
);

/* ------------------------------ owner controls ------------------------------ */

router.post(
  "/:id/topup",
  asyncHandler(async (req, res) => {
    const card = await loadCard(req.params.id);
    assertOwner(card, req.userId);
    if (card.terminated) throw badRequest("This card has been terminated");

    const existing = await checkIdempotencyKey(req);
    if (existing) return res.status(existing.statusCode).json(existing.responseBody);

    const { amount } = z.object({ amount: z.number().positive() }).parse(req.body);
    const mainCard = await myCard(req.userId);
    await debitCard(mainCard.id, { type: "transfer_out", amount, label: `Top-up: virtual card •••• ${card.last4}` });

    const [updated] = await prisma.$transaction([
      prisma.virtualCard.update({ where: { id: card.id }, data: { balance: { increment: amount } } }),
      prisma.virtualCardActivity.create({ data: { cardId: card.id, type: "topup", amount, label: "Topped up from main card", performedByUserId: req.userId } }),
    ]);

    const body = { card: serializeCard(updated, req.userId) };
    await saveIdempotentResponse(req, 200, body);
    await writeAudit(req.userId, "virtualcard.topup", { ip: req.ip, cardId: card.id, amount });
    res.json(body);
  })
);

// POST /virtual-cards/:id/transfer-to-main { amount } — the reverse direction
// of topup: moves funds off the add-on card back onto the owner's main
// card. Owner only, same as every other balance-moving action here — the
// holder has no path to move money in either direction (Requirement 5).
router.post(
  "/:id/transfer-to-main",
  asyncHandler(async (req, res) => {
    const card = await loadCard(req.params.id);
    assertOwner(card, req.userId);
    if (card.terminated) throw badRequest("This card has been terminated");

    const existing = await checkIdempotencyKey(req);
    if (existing) return res.status(existing.statusCode).json(existing.responseBody);

    const { amount } = z.object({ amount: z.number().positive() }).parse(req.body);
    if (Number(card.balance) < amount) throw badRequest("Insufficient add-on card balance");

    const mainCard = await myCard(req.userId);
    await getCardIssuingProvider().credit(mainCard.id, { type: "transfer_in", amount, label: `Transfer from add-on card •••• ${card.last4}` });

    const [updated] = await prisma.$transaction([
      prisma.virtualCard.update({ where: { id: card.id }, data: { balance: { decrement: amount } } }),
      prisma.virtualCardActivity.create({ data: { cardId: card.id, type: "transfer_to_main", amount, label: "Transferred to main card", performedByUserId: req.userId } }),
    ]);

    const body = { card: serializeCard(updated, req.userId) };
    await saveIdempotentResponse(req, 200, body);
    await writeAudit(req.userId, "virtualcard.transfer_to_main", { ip: req.ip, cardId: card.id, amount });
    res.json(body);
  })
);

// POST /virtual-cards/:id/services { services: { lipa, gepg, luku, topup } }
// Requirement 2: "define available services or transaction types" — owner only.
router.post(
  "/:id/services",
  asyncHandler(async (req, res) => {
    const card = await loadCard(req.params.id);
    assertOwner(card, req.userId);
    const { services } = z
      .object({ services: z.object({ lipa: z.boolean(), gepg: z.boolean(), luku: z.boolean(), topup: z.boolean() }) })
      .parse(req.body);

    const [updated] = await prisma.$transaction([
      prisma.virtualCard.update({ where: { id: card.id }, data: { services } }),
      prisma.virtualCardActivity.create({ data: { cardId: card.id, type: "services_updated", label: "Available services updated", performedByUserId: req.userId } }),
    ]);
    await writeAudit(req.userId, "virtualcard.services_updated", { ip: req.ip, cardId: card.id, services });
    res.json({ card: serializeCard(updated, req.userId) });
  })
);

router.post(
  "/:id/limit",
  asyncHandler(async (req, res) => {
    const card = await loadCard(req.params.id);
    assertOwner(card, req.userId);
    const { dailyLimit } = z.object({ dailyLimit: z.number().positive() }).parse(req.body);

    const [updated] = await prisma.$transaction([
      prisma.virtualCard.update({ where: { id: card.id }, data: { dailyLimit } }),
      prisma.virtualCardActivity.create({ data: { cardId: card.id, type: "limit_changed", label: `Daily limit set to ${dailyLimit}`, performedByUserId: req.userId } }),
    ]);
    await writeAudit(req.userId, "virtualcard.limit_changed", { ip: req.ip, cardId: card.id, dailyLimit });
    res.json({ card: serializeCard(updated, req.userId) });
  })
);

router.post(
  "/:id/freeze",
  asyncHandler(async (req, res) => {
    const card = await loadCard(req.params.id);
    assertOwner(card, req.userId);
    if (card.terminated) throw badRequest("This card has been terminated");
    const { frozen } = z.object({ frozen: z.boolean() }).parse(req.body);

    const [updated] = await prisma.$transaction([
      prisma.virtualCard.update({ where: { id: card.id }, data: { frozen } }),
      prisma.virtualCardActivity.create({ data: { cardId: card.id, type: frozen ? "frozen" : "unfrozen", label: frozen ? "Card frozen" : "Card unfrozen", performedByUserId: req.userId } }),
    ]);
    await writeAudit(req.userId, frozen ? "virtualcard.frozen" : "virtualcard.unfrozen", { ip: req.ip, cardId: card.id });
    res.json({ card: serializeCard(updated, req.userId) });
  })
);

router.post(
  "/:id/terminate",
  asyncHandler(async (req, res) => {
    const card = await loadCard(req.params.id);
    assertOwner(card, req.userId);
    if (card.terminated) return res.json({ card: serializeCard(card, req.userId) });

    const [updated] = await prisma.$transaction([
      prisma.virtualCard.update({ where: { id: card.id }, data: { terminated: true, frozen: true } }),
      prisma.virtualCardActivity.create({ data: { cardId: card.id, type: "terminated", label: "Card terminated", performedByUserId: req.userId } }),
    ]);
    await writeAudit(req.userId, "virtualcard.terminated", { ip: req.ip, cardId: card.id });
    res.json({ card: serializeCard(updated, req.userId) });
  })
);

router.post(
  "/:id/categories",
  asyncHandler(async (req, res) => {
    const card = await loadCard(req.params.id);
    assertOwner(card, req.userId);
    const { categoryIds } = z.object({ categoryIds: z.array(z.string()).nullable() }).parse(req.body);

    const [updated] = await prisma.$transaction([
      prisma.virtualCard.update({ where: { id: card.id }, data: { allowedCategoryIds: categoryIds } }),
      prisma.virtualCardActivity.create({ data: { cardId: card.id, type: "categories_updated", label: categoryIds ? `Restricted to ${categoryIds.length} categor${categoryIds.length === 1 ? "y" : "ies"}` : "Category restriction removed", performedByUserId: req.userId } }),
    ]);
    await writeAudit(req.userId, "virtualcard.categories_updated", { ip: req.ip, cardId: card.id, categoryIds });
    res.json({ card: serializeCard(updated, req.userId) });
  })
);

/* -------------------------------- holder spend -------------------------------- */

// POST /virtual-cards/:id/spend — the only action the holder can take that
// the owner can't (and vice versa: only the holder can spend, even on a
// parent-linked card the owner ultimately controls).
router.post(
  "/:id/spend",
  asyncHandler(async (req, res) => {
    const card = await loadCard(req.params.id);
    assertHolder(card, req.userId);
    if (card.terminated) throw badRequest("This card has been terminated");
    if (card.frozen) throw badRequest("This card is frozen");

    const existing = await checkIdempotencyKey(req);
    if (existing) return res.status(existing.statusCode).json(existing.responseBody);

    const { amount, merchant, categoryId, serviceType } = z
      .object({
        amount: z.number().positive(),
        merchant: z.string().min(1),
        categoryId: z.string().min(1),
        serviceType: z.enum(["lipa", "gepg", "luku", "topup", "other"]).default("other"),
      })
      .parse(req.body);

    if (serviceType !== "other" && card.services && card.services[serviceType] === false) {
      throw badRequest(`This card isn't permitted to use ${serviceType.toUpperCase()}`);
    }
    if (card.allowedCategoryIds && !card.allowedCategoryIds.includes(categoryId)) {
      throw badRequest("This card isn't permitted to spend in that category");
    }
    if (Number(card.balance) < amount) throw badRequest("Insufficient virtual card balance");

    const todayStart = new Date(); todayStart.setUTCHours(0, 0, 0, 0);
    const todaysSpend = await prisma.virtualCardActivity.aggregate({
      where: { cardId: card.id, type: "spend", date: { gte: todayStart } },
      _sum: { amount: true },
    });
    const spentSoFar = Number(todaysSpend._sum.amount || 0);
    if (spentSoFar + amount > Number(card.dailyLimit)) {
      throw badRequest(`This purchase would exceed the card's daily limit (${Number(card.dailyLimit)} used ${spentSoFar}/${card.dailyLimit} so far today)`);
    }

    const SERVICE_LABELS = { lipa: "Lipa", gepg: "GePG", luku: "LUKU", topup: "Mobile top-up", other: "Purchase" };
    const activityLabel = serviceType === "other" ? `Paid ${merchant}` : `${SERVICE_LABELS[serviceType]}: ${merchant}`;

    const requester = await prisma.user.findUniqueOrThrow({ where: { id: req.userId } });
    const [updated, , transaction] = await prisma.$transaction([
      prisma.virtualCard.update({ where: { id: card.id }, data: { balance: { decrement: amount } } }),
      prisma.virtualCardActivity.create({ data: { cardId: card.id, type: "spend", amount, label: activityLabel, performedByUserId: req.userId } }),
      prisma.transaction.create({
        data: {
          walletId: card.walletId,
          categoryId,
          amount: -Math.abs(amount),
          merchant,
          date: new Date(),
          loggedByUserId: req.userId,
          loggedByName: requester.firstName,
          source: serviceType === "other" ? "virtual_card" : `virtual_card_${serviceType}`,
        },
      }),
    ]);

    const body = { card: serializeCard(updated, req.userId), transaction };
    await saveIdempotentResponse(req, 200, body);
    await writeAudit(req.userId, "virtualcard.spend", { ip: req.ip, cardId: card.id, amount, merchant, serviceType });
    res.json(body);
  })
);

module.exports = router;
