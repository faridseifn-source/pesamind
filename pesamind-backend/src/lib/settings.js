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
  // Our own partner bank's TIPS Acquirer ID (BOT TANQR Annex 3: 2-digit
  // category + 3-digit participant code, e.g. "01001" for a bank). A scanned
  // QR whose Acquirer ID matches this is an on-us payment; anything else
  // routes off-us through TIPS. Placeholder until the real bank relationship
  // assigns a real code.
  partner_bank_acquirer_id: "01999",
  // Simulated failure injection, as a percentage string ("0"-"100") — lets
  // the reversal/reconciliation logic be genuinely tested without waiting
  // for a real failure. Zero by default (every simulated posting succeeds).
  cbs_simulated_failure_rate: "0",
  tips_simulated_failure_rate: "0",
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
