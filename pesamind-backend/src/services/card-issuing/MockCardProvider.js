const crypto = require("crypto");
const prisma = require("../../lib/prisma");
const { CardIssuingProvider } = require("./CardIssuingProvider");

// In mock mode our own `Card` row IS the ledger of truth, keyed by its own
// id (used here as the "externalCardId"). A real provider would instead be
// the source of truth, and our row would be a cache synced via webhook.
class MockCardProvider extends CardIssuingProvider {
  async issueCard({ userId, holderName }) {
    const card = await prisma.card.create({
      data: {
        userId,
        holderName,
        last4: String(1000 + Math.floor(Math.random() * 9000)),
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

  async credit(externalCardId, { type, amount, label, sub }) {
    const card = await prisma.card.update({
      where: { id: externalCardId },
      data: {
        balance: { increment: amount },
        activity: { create: { type, amount, label, sub } },
      },
      include: { activity: true },
    });
    return this._snapshot(card);
  }

  async debit(externalCardId, { type, amount, label, sub }) {
    const card = await prisma.card.findUniqueOrThrow({ where: { id: externalCardId } });
    if (Number(card.balance) < amount) {
      const err = new Error("Insufficient card balance");
      err.code = "INSUFFICIENT_FUNDS";
      throw err;
    }
    const updated = await prisma.card.update({
      where: { id: externalCardId },
      data: {
        balance: { decrement: amount },
        activity: { create: { type, amount: -amount, label, sub } },
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
