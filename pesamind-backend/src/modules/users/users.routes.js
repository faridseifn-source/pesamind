const { Router } = require("express");
const { z } = require("zod");
const prisma = require("../../lib/prisma");
const { requireAuth } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/errorHandler");
const { publicUser } = require("../../lib/serialize");

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

module.exports = router;
