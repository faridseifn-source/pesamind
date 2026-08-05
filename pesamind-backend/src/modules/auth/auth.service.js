const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const prisma = require("../../lib/prisma");
const env = require("../../lib/env");
const { signAccessToken, signRefreshToken, hashToken, verifyRefreshToken } = require("../../lib/jwt");
const { conflict, unauthorized, locked, badRequest } = require("../../lib/errors");
const { getCardIssuingProvider } = require("../../services/card-issuing");
const { getEmailProvider } = require("../../services/email");
const { writeAudit } = require("../../lib/audit");

async function registerUser({ firstName, lastName, email, phone, password, phoneVerifyToken }) {
  const existing = await prisma.user.findFirst({ where: { OR: [{ email }, { phone }] } });
  if (existing) throw conflict("An account with this email or phone already exists");

  const phoneRecord = await prisma.phoneVerification.findFirst({
    where: { phone, verifyToken: phoneVerifyToken, verified: true, usedAt: null },
  });
  if (!phoneRecord) throw badRequest("Phone number not verified. Please verify your number again.");

  const passwordHash = await bcrypt.hash(password, 10);

  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: { firstName, lastName, email, phone, passwordHash },
    });

    // Every user gets a personal wallet on signup.
    await tx.wallet.create({
      data: {
        type: "PERSONAL",
        members: { create: { userId: created.id, role: "owner" } },
      },
    });

    await tx.phoneVerification.update({ where: { id: phoneRecord.id }, data: { usedAt: new Date() } });

    return created;
  });

  // Issue the prepaid card via the card-issuing provider (mock today).
  const cardIssuing = getCardIssuingProvider();
  await cardIssuing.issueCard({ userId: user.id, holderName: `${firstName} ${lastName}`.toUpperCase() });

  return user;
}

async function authenticate(email, password, ip) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw unauthorized("Invalid email or password");

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    const minutesLeft = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
    throw locked(`Too many failed attempts. Try again in ${minutesLeft} minute(s).`);
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    const attempts = user.failedLoginAttempts + 1;
    const lockingNow = attempts >= env.security.maxLoginAttempts;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: attempts,
        lockedUntil: lockingNow ? new Date(Date.now() + env.security.loginLockoutMs) : null,
      },
    });
    await writeAudit(user.id, lockingNow ? "auth.login.locked" : "auth.login.failed", { ip, attempts });
    if (lockingNow) throw locked(`Too many failed attempts. Try again in ${Math.ceil(env.security.loginLockoutMs / 60000)} minute(s).`);
    throw unauthorized("Invalid email or password");
  }

  if (user.failedLoginAttempts > 0 || user.lockedUntil) {
    await prisma.user.update({ where: { id: user.id }, data: { failedLoginAttempts: 0, lockedUntil: null } });
  }
  await writeAudit(user.id, "auth.login.success", { ip });
  return user;
}

async function issueTokenPair(user) {
  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user);

  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + env.jwt.refreshMaxAgeMs),
    },
  });

  return { accessToken, refreshToken };
}

async function rotateRefreshToken(refreshToken) {
  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    throw unauthorized("Invalid or expired refresh token");
  }

  const tokenHash = hashToken(refreshToken);
  const stored = await prisma.refreshToken.findFirst({
    where: { userId: payload.sub, tokenHash, revoked: false },
  });
  if (!stored || stored.expiresAt < new Date()) throw unauthorized("Refresh token no longer valid");

  await prisma.refreshToken.update({ where: { id: stored.id }, data: { revoked: true } });

  const user = await prisma.user.findUniqueOrThrow({ where: { id: payload.sub } });
  return issueTokenPair(user);
}

async function revokeRefreshToken(refreshToken) {
  const tokenHash = hashToken(refreshToken);
  await prisma.refreshToken.updateMany({ where: { tokenHash }, data: { revoked: true } });
}

// Used whenever a password changes — every other device's session should
// end, since a stolen refresh token would otherwise survive a password reset.
async function revokeAllRefreshTokens(userId) {
  await prisma.refreshToken.updateMany({ where: { userId, revoked: false }, data: { revoked: true } });
}

const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Formatted like "A1B2-C3D4-E5F6" — short enough to type or paste from an
// email by hand, while still carrying enough entropy (12 chars from a
// 36-symbol alphabet = ~62 bits) to be safe given the 30-min expiry,
// single-use enforcement, and rate limiting already in place.
function generateResetCode() {
  const raw = crypto.randomBytes(6).toString("hex").toUpperCase(); // 12 hex chars
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}
const normalizeCode = (code) => code.replace(/[^A-Za-z0-9]/g, "").toUpperCase();

async function requestPasswordReset(email, ip) {
  const user = await prisma.user.findUnique({ where: { email } });
  // Deliberately don't reveal whether the email exists — same response either way.
  if (!user) return;

  const code = generateResetCode();
  await prisma.passwordResetToken.create({
    data: { userId: user.id, tokenHash: hashToken(normalizeCode(code)), expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS) },
  });
  await writeAudit(user.id, "auth.password_reset.requested", { ip });
  await getEmailProvider().sendPasswordReset(email, code);
}

async function resetPassword(token, newPassword, ip) {
  const tokenHash = hashToken(normalizeCode(token));
  const record = await prisma.passwordResetToken.findFirst({ where: { tokenHash, usedAt: null } });
  if (!record || record.expiresAt < new Date()) throw badRequest("This reset code is invalid or has expired.");

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await prisma.$transaction([
    prisma.user.update({ where: { id: record.userId }, data: { passwordHash, failedLoginAttempts: 0, lockedUntil: null } }),
    prisma.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
  ]);
  await revokeAllRefreshTokens(record.userId);
  await writeAudit(record.userId, "auth.password_reset.completed", { ip });
}

async function changePassword(userId, currentPassword, newPassword, ip) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const ok = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!ok) {
    await writeAudit(userId, "auth.password_change.failed", { ip });
    throw unauthorized("Current password is incorrect");
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash } });
  await revokeAllRefreshTokens(userId);
  await writeAudit(userId, "auth.password_change.success", { ip });
}

module.exports = {
  registerUser,
  authenticate,
  issueTokenPair,
  rotateRefreshToken,
  revokeRefreshToken,
  requestPasswordReset,
  resetPassword,
  changePassword,
};
