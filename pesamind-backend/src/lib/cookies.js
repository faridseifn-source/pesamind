const env = require("./env");

const COOKIE_NAME = "pesamind_refresh_token";

function setRefreshCookie(res, refreshToken) {
  res.cookie(COOKIE_NAME, refreshToken, {
    httpOnly: true, // JavaScript in the browser cannot read this — the key XSS mitigation
    secure: env.nodeEnv === "production", // requires HTTPS in production
    sameSite: env.nodeEnv === "production" ? "none" : "lax", // "none" needed once frontend/API are on different domains
    maxAge: env.jwt.refreshMaxAgeMs,
    path: "/auth",
  });
}

function clearRefreshCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: "/auth" });
}

module.exports = { COOKIE_NAME, setRefreshCookie, clearRefreshCookie };
