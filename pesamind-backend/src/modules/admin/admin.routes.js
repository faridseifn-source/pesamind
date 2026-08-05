const { Router } = require("express");
const { z } = require("zod");
const prisma = require("../../lib/prisma");
const { requireAuth } = require("../../middleware/auth");
const { requireAdmin, requireAdminRole } = require("../../middleware/admin");
const { asyncHandler } = require("../../middleware/errorHandler");
const { notFound, badRequest } = require("../../lib/errors");
const { decryptField } = require("../../lib/crypto");
const { writeAudit } = require("../../lib/audit");
const { publicUser } = require("../../lib/serialize");
const { getSetting, setSetting, DEFAULTS } = require("../../lib/settings");
const { computeStatement } = require("../../lib/statement");

const router = Router();
router.use(requireAuth, requireAdmin);

// Every view of a customer's full NIDA record, every block/unblock, every
// settings change is audit-logged — including which admin did it and when.

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

// Requirement: "some users might end up seeing very limited information."
// admin_viewer gets a redacted user shape — no full email/phone, no
// financial data. admin_support and admin_super get the full picture.
const maskEmail = (email) => email.replace(/^(.{2}).*(@.*)$/, "$1***$2");
const maskPhone = (phone) => `***${String(phone).slice(-4)}`;

function serializeUserForRole(user, adminRole) {
  const base = publicUser(user);
  if (adminRole === "admin_viewer") {
    return { id: base.id, firstName: base.firstName, lastName: base.lastName, email: maskEmail(base.email), phone: maskPhone(base.phone), kycStatus: base.kycStatus, createdAt: base.createdAt };
  }
  return base;
}

// GET /admin/users?search=&page=&pageSize=
router.get(
  "/users",
  asyncHandler(async (req, res) => {
    const { page, pageSize } = paginationSchema.parse(req.query);
    const search = (req.query.search || "").trim();
    const where = search
      ? {
          OR: [
            { firstName: { contains: search, mode: "insensitive" } },
            { lastName: { contains: search, mode: "insensitive" } },
            { email: { contains: search, mode: "insensitive" } },
            { phone: { contains: search } },
          ],
        }
      : {};

    const [total, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
    ]);
    res.json({ users: users.map((u) => serializeUserForRole(u, req.adminRole)), total, page, pageSize });
  })
);

// GET /admin/users/:userId/overview — a single call for an admin detail
// screen. Viewer tier gets the redacted shape and no financial/KYC detail.
router.get(
  "/users/:userId/overview",
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: req.params.userId } });
    if (!user) throw notFound("User not found");

    if (req.adminRole === "admin_viewer") {
      return res.json({ user: serializeUserForRole(user, req.adminRole), card: null, virtualCardCount: null, walletCount: null, kyc: null });
    }

    const [card, virtualCardCount, walletCount, kycProfile] = await Promise.all([
      prisma.card.findUnique({ where: { userId: user.id } }),
      prisma.virtualCard.count({ where: { OR: [{ ownerId: user.id }, { holderId: user.id }] } }),
      prisma.walletMember.count({ where: { userId: user.id } }),
      prisma.kycNidaProfile.findUnique({ where: { userId: user.id }, select: { syncStatus: true, syncedAt: true, sourceProvider: true } }),
    ]);

    res.json({
      user: serializeUserForRole(user, req.adminRole),
      card: card ? { balance: Number(card.balance), frozen: card.frozen, last4: card.last4, processorRef: card.processorRef } : null,
      virtualCardCount,
      walletCount,
      kyc: kycProfile,
    });
  })
);

router.get(
  "/users/:userId",
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: req.params.userId } });
    if (!user) throw notFound("User not found");
    res.json({ user: serializeUserForRole(user, req.adminRole) });
  })
);

// GET /admin/users/:userId/kyc — support tier and above only; every view audited.
router.get(
  "/users/:userId/kyc",
  requireAdminRole("admin_support"),
  asyncHandler(async (req, res) => {
    const profile = await prisma.kycNidaProfile.findUnique({ where: { userId: req.params.userId } });
    if (!profile) throw notFound("No NIDA profile on file for this user");

    const decrypted = {
      firstName: decryptField(profile.firstNameEnc),
      middleName: decryptField(profile.middleNameEnc),
      lastName: decryptField(profile.lastNameEnc),
      sex: decryptField(profile.sexEnc),
      dateOfBirth: decryptField(profile.dateOfBirthEnc),
      maritalStatus: decryptField(profile.maritalStatusEnc),
      placeOfBirth: decryptField(profile.placeOfBirthEnc),
      citizenshipType: decryptField(profile.citizenshipTypeEnc),
      nidaPhone: decryptField(profile.nidaPhoneEnc),
      region: decryptField(profile.regionEnc),
      district: decryptField(profile.districtEnc),
      ward: decryptField(profile.wardEnc),
      villageOrStreet: decryptField(profile.villageOrStreetEnc),
      photoUrl: decryptField(profile.photoEnc),
      sourceProvider: profile.sourceProvider,
      syncStatus: profile.syncStatus,
      syncError: profile.syncError,
      syncedAt: profile.syncedAt,
      lastAttemptAt: profile.lastAttemptAt,
    };

    await writeAudit(req.userId, "admin.kyc.viewed", { ip: req.ip, targetUserId: req.params.userId });
    res.json({ profile: decrypted });
  })
);

// GET /admin/users/:userId/statement?from=&to= — support tier and above.
router.get(
  "/users/:userId/statement",
  requireAdminRole("admin_support"),
  asyncHandler(async (req, res) => {
    const card = await prisma.card.findUnique({ where: { userId: req.params.userId } });
    if (!card) throw notFound("No card on file for this user");

    const now = new Date();
    const from = req.query.from ? new Date(req.query.from) : new Date(now.getFullYear(), now.getMonth(), 1);
    const to = req.query.to ? new Date(req.query.to) : now;
    if (isNaN(from.getTime()) || isNaN(to.getTime())) throw badRequest("Invalid from/to date");

    const activitySinceFrom = await prisma.cardActivity.findMany({ where: { cardId: card.id, date: { gte: from } }, orderBy: { date: "asc" } });
    const statement = computeStatement({ currentBalance: Number(card.balance), activitySinceFrom, from, to });
    await writeAudit(req.userId, "admin.statement_pulled", { ip: req.ip, targetUserId: req.params.userId, from, to });
    res.json(statement);
  })
);

// POST/DELETE block — super admin only. Blocking is immediate and locks the
// customer out of login entirely (distinct from the temporary brute-force
// lockout), so it's the most consequential single action in this portal.
router.post(
  "/users/:userId/block",
  requireAdminRole("admin_super"),
  asyncHandler(async (req, res) => {
    const { reason } = z.object({ reason: z.string().min(3).max(300) }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { id: req.params.userId } });
    if (!user) throw notFound("User not found");

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { blockedByAdmin: true, blockedReason: reason, blockedAt: new Date(), blockedByUserId: req.userId },
    });
    await writeAudit(req.userId, "admin.user.blocked", { ip: req.ip, targetUserId: user.id, reason });
    res.json({ user: publicUser(updated) });
  })
);

router.post(
  "/users/:userId/unblock",
  requireAdminRole("admin_super"),
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: req.params.userId } });
    if (!user) throw notFound("User not found");

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { blockedByAdmin: false, blockedReason: null, blockedAt: null, blockedByUserId: null },
    });
    await writeAudit(req.userId, "admin.user.unblocked", { ip: req.ip, targetUserId: user.id });
    res.json({ user: publicUser(updated) });
  })
);

/* -------------------------------- tickets -------------------------------- */
// admin_viewer: read-only. admin_support and above: create/update/resolve.

router.get(
  "/tickets",
  asyncHandler(async (req, res) => {
    const { page, pageSize } = paginationSchema.parse(req.query);
    const where = {
      ...(req.query.status ? { status: req.query.status } : {}),
      ...(req.query.userId ? { userId: req.query.userId } : {}),
    };
    const [total, tickets] = await Promise.all([
      prisma.supportTicket.count({ where }),
      prisma.supportTicket.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize, include: { user: { select: { firstName: true, lastName: true, phone: true } } } }),
    ]);
    res.json({ tickets, total, page, pageSize });
  })
);

router.post(
  "/tickets",
  requireAdminRole("admin_support"),
  asyncHandler(async (req, res) => {
    const { userId, category, subject, description, relatedTransactionId } = z
      .object({ userId: z.string().min(1), category: z.enum(["dispute", "inquiry", "complaint", "fraud"]), subject: z.string().min(3).max(150), description: z.string().min(3).max(2000), relatedTransactionId: z.string().optional() })
      .parse(req.body);
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw notFound("User not found");

    const ticket = await prisma.supportTicket.create({
      data: { userId, category, subject, description, relatedTransactionId, loggedByAdminId: req.userId },
    });
    await writeAudit(req.userId, "admin.ticket.created", { ip: req.ip, targetUserId: userId, ticketId: ticket.id });
    res.status(201).json({ ticket });
  })
);

router.patch(
  "/tickets/:ticketId",
  requireAdminRole("admin_support"),
  asyncHandler(async (req, res) => {
    const { status, resolutionNotes, assignedAdminId } = z
      .object({ status: z.enum(["open", "in_progress", "resolved", "closed"]).optional(), resolutionNotes: z.string().max(2000).optional(), assignedAdminId: z.string().optional() })
      .parse(req.body);
    const ticket = await prisma.supportTicket.findUnique({ where: { id: req.params.ticketId } });
    if (!ticket) throw notFound("Ticket not found");

    const updated = await prisma.supportTicket.update({
      where: { id: ticket.id },
      data: {
        ...(status ? { status } : {}),
        ...(resolutionNotes !== undefined ? { resolutionNotes } : {}),
        ...(assignedAdminId !== undefined ? { assignedAdminId } : {}),
        ...(status === "resolved" || status === "closed" ? { resolvedAt: new Date() } : {}),
      },
    });
    await writeAudit(req.userId, "admin.ticket.updated", { ip: req.ip, ticketId: ticket.id, status });
    res.json({ ticket: updated });
  })
);

/* ------------------------------- dashboard -------------------------------- */

// GET /admin/dashboard — summary counters for the portal's landing screen.
router.get(
  "/dashboard",
  asyncHandler(async (req, res) => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);

    const [totalUsers, activeUsers, newUsersThisMonth, kycVerified, kycPending, blockedUsers, openTickets, cardBalanceAgg] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { lastLoginAt: { gte: thirtyDaysAgo } } }),
      prisma.user.count({ where: { createdAt: { gte: monthStart } } }),
      prisma.user.count({ where: { kycStatus: "VERIFIED" } }),
      prisma.user.count({ where: { kycStatus: { in: ["NONE", "PENDING"] } } }),
      prisma.user.count({ where: { blockedByAdmin: true } }),
      prisma.supportTicket.count({ where: { status: { in: ["open", "in_progress"] } } }),
      req.adminRole === "admin_viewer" ? null : prisma.card.aggregate({ _sum: { balance: true } }),
    ]);

    res.json({
      totalUsers,
      activeUsers30d: activeUsers,
      newUsersThisMonth,
      kycVerified,
      kycPending,
      blockedUsers,
      openTickets,
      totalCardBalance: cardBalanceAgg ? Number(cardBalanceAgg._sum.balance || 0) : null, // null (hidden) for viewer tier
    });
  })
);

// System settings — super admin only to change; any admin tier can view.
router.get(
  "/settings",
  asyncHandler(async (req, res) => {
    const keys = Object.keys(DEFAULTS);
    const values = await Promise.all(keys.map((k) => getSetting(k)));
    res.json({ settings: Object.fromEntries(keys.map((k, i) => [k, values[i]])) });
  })
);

router.patch(
  "/settings/:key",
  requireAdminRole("admin_super"),
  asyncHandler(async (req, res) => {
    const { key } = req.params;
    if (!(key in DEFAULTS)) throw notFound("Unknown setting key");
    const { value } = z.object({ value: z.string().min(1) }).parse(req.body);
    await setSetting(key, value);
    await writeAudit(req.userId, "admin.setting_updated", { ip: req.ip, key, value });
    res.json({ key, value });
  })
);

// GET /admin/audit-logs?userId=&action=&page=&pageSize= — support tier and above.
router.get(
  "/audit-logs",
  requireAdminRole("admin_support"),
  asyncHandler(async (req, res) => {
    const { page, pageSize } = paginationSchema.parse(req.query);
    const where = {
      ...(req.query.userId ? { userId: req.query.userId } : {}),
      ...(req.query.action ? { action: { contains: req.query.action } } : {}),
    };
    const [total, logs] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
    ]);
    res.json({ logs: logs.map((l) => ({ ...l, amount: l.amount === null ? null : Number(l.amount) })), total, page, pageSize });
  })
);

module.exports = router;
