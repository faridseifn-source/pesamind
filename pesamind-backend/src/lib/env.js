require("dotenv").config();

function required(name, fallback) {
  const val = process.env[name] ?? fallback;
  if (val === undefined) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return val;
}

module.exports = {
  port: Number(process.env.PORT || 4000),
  nodeEnv: process.env.NODE_ENV || "development",
  corsOrigin: process.env.CORS_ORIGIN || "http://localhost:5173",

  jwt: {
    accessSecret: required("JWT_ACCESS_SECRET", "dev_access_secret_change_me"),
    refreshSecret: required("JWT_REFRESH_SECRET", "dev_refresh_secret_change_me"),
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || "15m",
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "30d",
    refreshMaxAgeMs: 30 * 24 * 60 * 60 * 1000, // 30 days — keep in sync with refreshExpiresIn above
  },

  security: {
    maxLoginAttempts: Number(process.env.MAX_LOGIN_ATTEMPTS || 5),
    loginLockoutMs: Number(process.env.LOGIN_LOCKOUT_MINUTES || 15) * 60 * 1000,
    maxKycAttempts: Number(process.env.MAX_KYC_ATTEMPTS || 5),
  },

  providers: {
    kyc: process.env.KYC_PROVIDER || "mock",
    paymentsRail: process.env.PAYMENTS_RAIL_PROVIDER || "mock",
    cardFunding: process.env.CARD_FUNDING_PROVIDER || "mock",
    cardIssuing: process.env.CARD_ISSUING_PROVIDER || "mock",
  },

  kycThresholdTZS: Number(process.env.KYC_AMOUNT_THRESHOLD_TZS || 50000),
};
