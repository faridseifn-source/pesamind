const env = require("../../lib/env");
const { MockCardProvider } = require("./MockCardProvider");

let instance;

function getCardIssuingProvider() {
  if (instance) return instance;

  switch (env.providers.cardIssuing) {
    case "processor":
      // const { ProcessorCardProvider } = require("./ProcessorCardProvider");
      // instance = new ProcessorCardProvider({ ...program manager credentials... });
      throw new Error("CARD_ISSUING_PROVIDER=processor is not implemented yet — use 'mock'");
    case "mock":
    default:
      instance = new MockCardProvider();
  }
  return instance;
}

module.exports = { getCardIssuingProvider };
