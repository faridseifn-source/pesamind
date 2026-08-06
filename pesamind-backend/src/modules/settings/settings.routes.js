const { Router } = require("express");
const { requireAuth } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/errorHandler");
const { getSetting } = require("../../lib/settings");

const router = Router();
router.use(requireAuth);

// A deliberately curated whitelist — only settings that are safe for any
// authenticated customer to read (nothing about BIN, CMS provider details,
// or anything else an admin-only screen should gate). Never just proxy the
// full settings table here.
const PUBLIC_KEYS = ["qr_test_samples_enabled", "qr_step_up_threshold", "household_max_members"];

router.get(
  "/public",
  asyncHandler(async (req, res) => {
    const values = await Promise.all(PUBLIC_KEYS.map((k) => getSetting(k)));
    res.json({ settings: Object.fromEntries(PUBLIC_KEYS.map((k, i) => [k, values[i]])) });
  })
);

module.exports = router;
