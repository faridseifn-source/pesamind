/**
 * Contract every KYC provider must satisfy. The real NIDA integration is
 * actually two external systems behind one interface:
 *   - NIDA (or an approved Reliant Party gateway) for identity lookup + KBV
 *   - An SMS/USSD gateway (MNO-specific or aggregated) for OTP delivery,
 *     since the phone number tied to an identity is SIM-registration data,
 *     not something NIDA itself exposes.
 *
 * @typedef {Object} NidaRecord
 * @property {string} refId            Opaque reference for this lookup (not the raw NIDA number)
 * @property {string} maskedName
 * @property {string} maskedPhone
 * @property {string} ward
 * @property {string} district
 * @property {string} region
 * @property {string} issueYear
 *
 * @typedef {Object} KbvQuestion
 * @property {string} id
 * @property {string} prompt
 * @property {string[]} options
 */
class KycProvider {
  /** @param {string} nidaNumber @returns {Promise<NidaRecord>} */
  async lookupIdentity(nidaNumber) {
    throw new Error("lookupIdentity not implemented");
  }

  /** @param {string} refId @returns {Promise<{ sent: boolean, expiresInSec: number }>} */
  async sendOtp(refId) {
    throw new Error("sendOtp not implemented");
  }

  /** @param {string} refId @param {string} code @returns {Promise<boolean>} */
  async verifyOtp(refId, code) {
    throw new Error("verifyOtp not implemented");
  }

  /** @param {string} refId @returns {Promise<KbvQuestion[]>} */
  async getKbvQuestions(refId) {
    throw new Error("getKbvQuestions not implemented");
  }

  /** @param {string} refId @param {Record<string,string>} answers @returns {Promise<{ passed: boolean, correctCount: number }>} */
  async verifyKbv(refId, answers) {
    throw new Error("verifyKbv not implemented");
  }
}

module.exports = { KycProvider };
