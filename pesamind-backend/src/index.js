const app = require("./app");
const env = require("./lib/env");

app.listen(env.port, () => {
  console.log(`PesaMind API listening on :${env.port} [${env.nodeEnv}]`); // eslint-disable-line no-console
  console.log(
    `Providers -> kyc:${env.providers.kyc} rail:${env.providers.paymentsRail} funding:${env.providers.cardFunding} issuing:${env.providers.cardIssuing}`
  ); // eslint-disable-line no-console
});
