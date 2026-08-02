const { Router } = require("express");
const { z } = require("zod");
const prisma = require("../../lib/prisma");
const { requireAuth } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/errorHandler");
const { publicUser } = require("../../lib/serialize");
const { changePasswordSchema } = require("../auth/auth.schema");
const authService = require("../auth/auth.service");

const router = Router();
router.use(requireAuth);

const updateSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  language: z.enum(["en", "sw"]).optional(),
  avatarUrl: z.string().url().nullable().optional(),
});

router.patch(
  "/me",
  asyncHandler(async (req, res) => {
    const patch = updateSchema.parse(req.body);
    const user = await prisma.user.update({ where: { id: req.userId }, data: patch });
    res.json({ user: publicUser(user) });
  })
);

router.post(
  "/me/password",
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);
    await authService.changePassword(req.userId, currentPassword, newPassword, req.ip);
    // All sessions (including this one's refresh token) were just revoked —
    // the client should treat this as a forced logout and send the user to log back in.
    res.json({ message: "Password changed. Please log in again." });
  })
);

module.exports = router;
