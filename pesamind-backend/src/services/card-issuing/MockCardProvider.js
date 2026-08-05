const prisma = require("../../lib/prisma");
const { CardIssuingProvider } = require("./CardIssuingProvider");
const { genCardCredentials } = require("../../lib/cardCredentials");
const { encryptField } = require("../../lib/crypto");

// In mock mode our own `Card` row IS the ledger of truth, keyed by its own
// id (used here as the "externalCardId"). A real provider would instead be
// the source of truth, and our row would be a cache synced via webhook.
class MockCardProvider extends CardIssuingProvider {
  async issueCard({ userId, holderName }) {
    const { last4, fullNumber, cvv } = genCardCredentials();
    const card = await prisma.card.create({
      data: {
        userId,
        holderName,
        last4,
        fullNumberEnc: encryptField(fullNumber),
        cvvEnc: encryptField(cvv),
        expiry: "09/29",
        balance: 0,
        controls: { online: true, contactless: true, atm: true },
      },
    });
    return this._snapshot(card);
  }

  async getBalance(externalCardId) {
    const card = await prisma.card.findUniqueOrThrow({ where: { id: externalCardId } });
    return this._snapshot(card);
  }

  async setFrozen(externalCardId, frozen) {
    const card = await prisma.card.update({ where: { id: externalCardId }, data: { frozen } });
    return this._snapshot(card);
  }

  async setControls(externalCardId, controls) {
    const card = await prisma.card.update({ where: { id: externalCardId }, data: { controls } });
    return this._snapshot(card);
  }

  async setDailyLimit(externalCardId, dailyLimit) {
    const card = await prisma.card.update({ where: { id: externalCardId }, data: { dailyLimit } });
    return this._snapshot(card);
  }

  // `client` defaults to the module-level prisma singleton, but callers doing
  // a card-to-card transfer can pass an interactive-transaction client (`tx`
  // from prisma.$transaction(async (tx) => ...)) so the debit on one card and
  // the credit on the other either both commit or both roll back together.
  // This only matters for the mock — a real processor's debit is an external
  // HTTP call and can never be inside our DB transaction; that's an inherent
  // limitation of any two-system transfer, which is why every money-movement
  // route here also requires an Idempotency-Key as the primary safety net.
  async credit(externalCardId, { type, amount, label, sub, transferGroupId }, client = prisma) {
    const card = await client.card.update({
      where: { id: externalCardId },
      data: {
        balance: { increment: amount },
        activity: { create: { type, amount, label, sub, transferGroupId } },
      },
      include: { activity: true },
    });
    return this._snapshot(card);
  }

  async debit(externalCardId, { type, amount, label, sub, transferGroupId }, client = prisma) {
    const card = await client.card.findUniqueOrThrow({ where: { id: externalCardId } });
    if (Number(card.balance) < amount) {
      const err = new Error("Insufficient card balance");
      err.code = "INSUFFICIENT_FUNDS";
      throw err;
    }
    const updated = await client.card.update({
      where: { id: externalCardId },
      data: {
        balance: { decrement: amount },
        activity: { create: { type, amount: -amount, label, sub, transferGroupId } },
      },
    });
    return this._snapshot(updated);
  }

  _snapshot(card) {
    return {
      externalCardId: card.id,
      balance: Number(card.balance),
      frozen: card.frozen,
      controls: card.controls,
    };
  }
}

module.exports = { MockCardProvider };
