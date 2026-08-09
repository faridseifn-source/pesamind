const { getExchangeRateProvider } = require("../services/exchange-rate");

/**
 * Converts an amount from one currency into the customer's running
 * currency, returning both the converted amount (what actually gets
 * stored as Transaction.amount) and the original-currency fields (what
 * gets stored in originalAmount/originalCurrency/exchangeRate for
 * transparency). Returns originals as null when no conversion was needed
 * (the transaction was already in the customer's currency) — that null-
 * ness is itself meaningful: it's how the rest of the app tells "this was
 * always TZS" apart from "this was converted from something else."
 */
async function convertToPreferredCurrency({ amount, currency, preferredCurrency }) {
  if (!currency || currency === preferredCurrency) {
    return { amount, originalAmount: null, originalCurrency: null, exchangeRate: null };
  }
  const rate = await getExchangeRateProvider().getRate(currency, preferredCurrency);
  const converted = Math.round(amount * rate * 100) / 100;
  return { amount: converted, originalAmount: amount, originalCurrency: currency, exchangeRate: rate };
}

module.exports = { convertToPreferredCurrency };
