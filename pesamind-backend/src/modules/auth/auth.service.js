const bcrypt = require("bcryptjs");
const prisma = require("../../lib/prisma");
const env = require("../../lib/env");
const { signAccessToken, signRefreshToken, hashToken, verifyRefreshToken } = require("../../lib/jwt");
const { conflict, unauthorized, locked } = require("../../lib/errors");
const { getCardIssuingProvider } = require("../../services/card-issuing");
const { writeAudit } = require("../../lib/audit");

async function registerUser({ firstName, lastName, email, phone, password }) {
  const existing = await prisma.user.findFirst({ where: { OR: [{ email }, { phone }] } });
  if (existing) throw conflict("An account with this email or phone already exists");

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

module.exports = { registerUser, authenticate, issueTokenPair, rotateRefreshToken, revokeRefreshToken };
