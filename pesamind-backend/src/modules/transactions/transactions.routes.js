const { Router } = require("express");
const { z } = require("zod");
const prisma = require("../../lib/prisma");
const { requireAuth } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/errorHandler");
const { notFound, forbidden, badRequest } = require("../../lib/errors");
const { assertWalletMember, userWalletIds } = require("../wallets/wallets.helpers");
const { notifyUser } = require("../../lib/notify");
const { getSetting } = require("../../lib/settings");
const { csvRow, sendCsv } = require("../../lib/csv");

const router = Router();
router.use(requireAuth);

const txInput = z.object({
  walletId: z.string().min(1),
  categoryId: z.string().min(1),
  subcategoryId: z.string().min(1).optional().nullable(),
  amount: z.number(), // negative = expense, positive = income
  merchant: z.string().min(1),
  note: z.string().optional().nullable(),
  photoUrl: z.string().optional().nullable(),
  date: z.string(), // ISO date
  source: z.enum(["manual", "scan", "voice", "import", "lipa", "gepg", "luku"]).default("manual"),
});

// GET /transactions?walletId=&from=&to=&category=&format=csv
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const walletIds = await userWalletIds(req.userId);
    const { walletId, from, to, categoryId } = req.query;

    if (walletId && !walletIds.includes(walletId)) throw forbidden("Not a member of this wallet");

    const where = {
      walletId: walletId ? walletId : { in: walletIds },
      ...(categoryId ? { categoryId } : {}),
      ...(from || to
        ? { date: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } }
        : {}),
    };

    const transactions = await prisma.transaction.findMany({
      where,
      orderBy: { date: "desc" },
      include: { category: true, subcategory: true },
    });

    if (req.query.format === "csv") {
      const enabled = (await getSetting("pfm_export_enabled")) !== "false";
      if (!enabled) throw forbidden("Exporting your transaction history is currently turned off.");
      if (!from || !to) throw badRequest("Select a date range to export.");

      let out = csvRow(["PesaMind Transaction Export"]);
      out += csvRow(["Period", `${from} to ${to}`]);
      out += csvRow(["Generated", new Date().toISOString()]);
      out += csvRow(["Total transactions", transactions.length]);
      out += csvRow([]);
      out += csvRow(["Date", "Merchant", "Category", "Subcategory", "Type", "Amount TZS", "Note"]);
      for (const tx of transactions) {
        out += csvRow([
          tx.date.toISOString().slice(0, 10),
          tx.merchant,
          tx.category?.name || "",
          tx.subcategory?.name || "",
          Number(tx.amount) >= 0 ? "Income" : "Expense",
          Math.abs(Number(tx.amount)),
          tx.note || "",
        ]);
      }
      return sendCsv(res, `pesamind-transactions-${from}-to-${to}.csv`, out);
    }

    res.json({ transactions });
  })
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = txInput.parse(req.body);
    await assertWalletMember(req.userId, input.walletId);

    const requester = await prisma.user.findUniqueOrThrow({ where: { id: req.userId } });
    const transaction = await prisma.transaction.create({
      data: {
        ...input,
        date: new Date(input.date),
        loggedByUserId: req.userId,
        loggedByName: `${requester.firstName}`,
      },
      include: { category: true, subcategory: true, wallet: true },
    });

    // Only shared wallets notify — and only the OTHER members, never the
    // person who just logged it (they already see it appear in their own
    // UI immediately; notifying them too would just be noise).
    if (transaction.wallet.type === "SHARED") {
      const otherMembers = await prisma.walletMember.findMany({ where: { walletId: input.walletId, userId: { not: req.userId } } });
      await Promise.all(otherMembers.map((m) => notifyUser(m.userId, {
        type: "shared_expense",
        title: "New shared expense",
        message: `${requester.firstName} logged ${Math.abs(Number(transaction.amount)).toLocaleString()} TZS at ${transaction.merchant}`,
        url: "/",
      })));
    }

    res.status(201).json({ transaction });
  })
);

// Bulk import (e.g. bank statement ingest, already parsed client-side).
router.post(
  "/bulk",
  asyncHandler(async (req, res) => {
    const items = z.array(txInput).min(1).parse(req.body.transactions);
    const walletIds = [...new Set(items.map((i) => i.walletId))];
    for (const walletId of walletIds) await assertWalletMember(req.userId, walletId);

    const requester = await prisma.user.findUniqueOrThrow({ where: { id: req.userId } });
    const created = await prisma.$transaction(
      items.map((input) =>
        prisma.transaction.create({
          data: { ...input, date: new Date(input.date), loggedByUserId: req.userId, loggedByName: requester.firstName, source: "import" },
        })
      )
    );
    res.status(201).json({ transactions: created });
  })
);

router.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const patch = txInput.partial().parse(req.body);
    const existing = await prisma.transaction.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound("Transaction not found");
    await assertWalletMember(req.userId, existing.walletId);

    const transaction = await prisma.transaction.update({
      where: { id: existing.id },
      data: { ...patch, ...(patch.date ? { date: new Date(patch.date) } : {}) },
      include: { category: true, subcategory: true },
    });
    res.json({ transaction });
  })
);

router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const existing = await prisma.transaction.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound("Transaction not found");
    await assertWalletMember(req.userId, existing.walletId);
    await prisma.transaction.delete({ where: { id: existing.id } });
    res.status(204).send();
  })
);

router.post(
  "/bulk-delete",
  asyncHandler(async (req, res) => {
    const { ids } = z.object({ ids: z.array(z.string()).min(1) }).parse(req.body);
    const existing = await prisma.transaction.findMany({ where: { id: { in: ids } } });
    const walletIds = [...new Set(existing.map((t) => t.walletId))];
    if (walletIds.length === 0) throw badRequest("No matching transactions");
    for (const walletId of walletIds) await assertWalletMember(req.userId, walletId);

    await prisma.transaction.deleteMany({ where: { id: { in: ids } } });
    res.status(204).send();
  })
);

module.exports = router;
