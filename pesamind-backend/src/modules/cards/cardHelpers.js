const prisma = require("../../lib/prisma");
const { notFound, badRequest } = require("../../lib/errors");
const { getCardIssuingProvider } = require("../../services/card-issuing");

async function myCard(userId) {
  const card = await prisma.card.findUnique({ where: { userId } });
  if (!card) throw notFound("No card provisioned for this user");
  return card;
}

// Wraps the provider's debit() so "not enough money" comes back as a clear
// 400 the client can show, instead of an uncaught error turning into a
// generic 500. `client` optionally lets the caller run this inside an
// interactive prisma transaction (see MockCardProvider for why this matters).
async function debitCard(cardId, details, client) {
  try {
    return await getCardIssuingProvider().debit(cardId, details, client);
  } catch (err) {
    if (err.code === "INSUFFICIENT_FUNDS") throw badRequest("Insufficient card balance. Please top up your card first.");
    throw err;
  }
}

module.exports = { myCard, debitCard };
