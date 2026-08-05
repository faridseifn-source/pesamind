function genLast4() {
  return String(1000 + Math.floor(Math.random() * 9000));
}

// Generates a plausible-looking 16-digit PAN (not a real card scheme/Luhn
// check — this is a mock issuer) and a 3-digit CVV, both encrypted before
// storage by the caller. Real card numbers should only ever come from a
// real processor once that integration exists.
function genCardCredentials() {
  const last4 = genLast4();
  const middle = String(Math.floor(10000000000 + Math.random() * 90000000000)); // 11 digits
  const fullNumber = `4${middle}${last4}`; // 1 + 11 + 4 = 16 digits, ends in last4
  const cvv = String(100 + Math.floor(Math.random() * 900));
  return { last4, fullNumber, cvv };
}

module.exports = { genLast4, genCardCredentials };
