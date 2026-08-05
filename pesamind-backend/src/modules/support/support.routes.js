const { Router } = require("express");
const { z } = require("zod");
const rateLimit = require("express-rate-limit");
const prisma = require("../../lib/prisma");
const { requireAuth } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/errorHandler");
const { notFound, forbidden } = require("../../lib/errors");
const { writeAudit } = require("../../lib/audit");

const router = Router();
router.use(requireAuth);

// A customer filing many tickets in a burst is more likely spam/abuse than
// genuine need — keep this generous but not unlimited.
const ticketLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });

// POST /support/tickets — a customer raises a request or dispute themselves.
router.post(
  "/tickets",
  ticketLimiter,
  asyncHandler(async (req, res) => {
    const { category, subject, description, relatedTransactionId } = z
      .object({
        category: z.enum(["dispute", "inquiry", "complaint", "fraud"]),
        subject: z.string().min(3).max(150),
        description: z.string().min(3).max(2000),
        relatedTransactionId: z.string().optional(),
      })
      .parse(req.body);

    const ticket = await prisma.supportTicket.create({
      data: { userId: req.userId, category, subject, description, relatedTransactionId },
    });
    await writeAudit(req.userId, "support.ticket.created", { ip: req.ip, ticketId: ticket.id, category });
    res.status(201).json({ ticket });
  })
);

// GET /support/tickets — the customer's own tickets only.
router.get(
  "/tickets",
  asyncHandler(async (req, res) => {
    const tickets = await prisma.supportTicket.findMany({ where: { userId: req.userId }, orderBy: { createdAt: "desc" } });
    res.json({ tickets });
  })
);

router.get(
  "/tickets/:ticketId",
  asyncHandler(async (req, res) => {
    const ticket = await prisma.supportTicket.findUnique({ where: { id: req.params.ticketId } });
    if (!ticket || ticket.userId !== req.userId) throw notFound("Ticket not found");
    res.json({ ticket });
  })
);

module.exports = router;
