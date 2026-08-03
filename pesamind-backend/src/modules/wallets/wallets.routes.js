const { Router } = require("express");
const { z } = require("zod");
const prisma = require("../../lib/prisma");
const { requireAuth } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/errorHandler");
const { notFound, forbidden } = require("../../lib/errors");

const router = Router();
router.use(requireAuth);

// GET /wallets — all wallets this user belongs to (personal + shared).
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const memberships = await prisma.walletMember.findMany({
      where: { userId: req.userId },
      include: { wallet: { include: { members: { include: { user: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } } } } } } },
    });
    res.json({ wallets: memberships.map((m) => m.wallet) });
  })
);

// POST /wallets — create a shared wallet, creator becomes owner.
router.post(
  "/",
  asyncHandler(async (req, res) => {
    const { name } = z.object({ name: z.string().trim().min(1) }).parse(req.body);
    const wallet = await prisma.wallet.create({
      data: { type: "SHARED", name, members: { create: { userId: req.userId, role: "owner" } } },
      include: { members: true },
    });
    res.status(201).json({ wallet });
  })
);

// POST /wallets/:id/members — invite/add a member by userId (real invite-by-phone flow can wrap this later).
router.post(
  "/:id/members",
  asyncHandler(async (req, res) => {
    const { userId } = z.object({ userId: z.string().min(1) }).parse(req.body);
    const wallet = await prisma.wallet.findUnique({ where: { id: req.params.id }, include: { members: true } });
    if (!wallet) throw notFound("Wallet not found");
    const requester = wallet.members.find((m) => m.userId === req.userId);
    if (!requester) throw forbidden("Not a member of this wallet");

    const member = await prisma.walletMember.create({ data: { walletId: wallet.id, userId, role: "member" } });
    res.status(201).json({ member });
  })
);

router.delete(
  "/:id/members/:userId",
  asyncHandler(async (req, res) => {
    const wallet = await prisma.wallet.findUnique({ where: { id: req.params.id }, include: { members: true } });
    if (!wallet) throw notFound("Wallet not found");
    const requester = wallet.members.find((m) => m.userId === req.userId);
    if (!requester || requester.role !== "owner") throw forbidden("Only the wallet owner can remove members");

    await prisma.walletMember.deleteMany({ where: { walletId: wallet.id, userId: req.params.userId } });
    res.status(204).send();
  })
);

module.exports = router;
