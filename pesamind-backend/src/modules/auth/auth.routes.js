const { Router } = require("express");
const rateLimit = require("express-rate-limit");
const prisma = require("../../lib/prisma");
const { asyncHandler } = require("../../middleware/errorHandler");
const { requireAuth } = require("../../middleware/auth");
const { publicUser } = require("../../lib/serialize");
const { unauthorized } = require("../../lib/errors");
const { setRefreshCookie, clearRefreshCookie, COOKIE_NAME } = require("../../lib/cookies");
const { registerSchema, loginSchema } = require("./auth.schema");
const authService = require("./auth.service");

const router = Router();

// Auth endpoints are the most brute-forceable surface in the app — keep them tightly limited.
// This is on top of the per-account lockout in auth.service (which survives a server restart;
// this limiter additionally slows down attempts spread across many different accounts/IPs).
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });

router.post(
  "/register",
  authLimiter,
  asyncHandler(async (req, res) => {
    const input = registerSchema.parse(req.body);
    const user = await authService.registerUser(input);
    const { accessToken, refreshToken } = await authService.issueTokenPair(user);
    setRefreshCookie(res, refreshToken);
    res.status(201).json({ user: publicUser(user), accessToken });
  })
);

router.post(
  "/login",
  authLimiter,
  asyncHandler(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    const user = await authService.authenticate(email, password, req.ip);
    const { accessToken, refreshToken } = await authService.issueTokenPair(user);
    setRefreshCookie(res, refreshToken);
    res.json({ user: publicUser(user), accessToken });
  })
);

router.post(
  "/refresh",
  authLimiter,
  asyncHandler(async (req, res) => {
    const refreshToken = req.cookies?.[COOKIE_NAME];
    if (!refreshToken) throw unauthorized("No refresh token cookie present");
    const { accessToken, refreshToken: newRefreshToken } = await authService.rotateRefreshToken(refreshToken);
    setRefreshCookie(res, newRefreshToken);
    res.json({ accessToken });
  })
);

router.post(
  "/logout",
  asyncHandler(async (req, res) => {
    const refreshToken = req.cookies?.[COOKIE_NAME];
    if (refreshToken) await authService.revokeRefreshToken(refreshToken);
    clearRefreshCookie(res);
    res.status(204).send();
  })
);

router.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId } });
    res.json({ user: publicUser(user) });
  })
);

module.exports = router;
