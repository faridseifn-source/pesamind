const prisma = require("./prisma");

const DEFAULTS = {
  household_max_members: "3",
  // CMS (Card Management System) configuration — non-secret values only.
  // Real credentials/URLs for a live CMS connection belong in environment
  // variables, never in this DB-backed settings table (an admin-portal
  // screen reading this table should never be able to leak a live secret).
  // BIN (Bank Identification Number) is genuinely a business parameter, not
  // a secret, and real CMS platforms (e.g. BPC SmartVista) configure it per
  // card "Product" — this is that same configuration point, simulated.
  card_bin: "428427", // 6-digit BIN prefix used when generating mock card numbers
  cms_provider_label: "mock", // human-readable label shown in an admin portal, e.g. "BPC SmartVista (sandbox)"
};

async function getSetting(key) {
  const row = await prisma.systemSetting.findUnique({ where: { key } });
  return row ? row.value : DEFAULTS[key];
}

async function getSettingNumber(key) {
  const val = await getSetting(key);
  return val === undefined ? undefined : Number(val);
}

async function setSetting(key, value) {
  return prisma.systemSetting.upsert({
    where: { key },
    update: { value: String(value) },
    create: { key, value: String(value) },
  });
}

module.exports = { getSetting, getSettingNumber, setSetting, DEFAULTS };
