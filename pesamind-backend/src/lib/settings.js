const prisma = require("./prisma");

const DEFAULTS = {
  household_max_members: "3",
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
