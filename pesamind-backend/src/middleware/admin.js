const prisma = require("../lib/prisma");
const { forbidden } = require("../lib/errors");

// Must run after requireAuth (needs req.userId already set).
async function requireAdmin(req, res, next) {
  const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { role: true } });
  if (!user || user.role !== "admin") return next(forbidden("Admin access required"));
  next();
}

module.exports = { requireAdmin };
