const crypto = require("crypto");
const { KycProvider } = require("./KycProvider");

const FIRST_NAMES = ["Amina", "Baraka", "Elias", "Furaha", "Grace", "Hamisi", "Irene", "Juma", "Neema", "Zawadi"];
const LAST_NAMES = ["Mushi", "Kileo", "Ngowi", "Massawe", "Mrema", "Kway", "Sanga", "Chuma", "Lyimo"];
const WARDS = ["Kinondoni", "Ilala", "Temeke", "Ubungo", "Kigamboni", "Magomeni", "Mikocheni", "Sinza"];
const DISTRICTS = ["Kinondoni", "Ilala", "Temeke", "Kigamboni", "Ubungo"];
const REGIONS = ["Dar es Salaam", "Mwanza", "Arusha", "Dodoma", "Mbeya", "Morogoro", "Tanga"];

function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
const maskName = (name) => `${name[0]}${"*".repeat(Math.max(2, name.length - 1))}`;
const shuffle = (arr) => [...arr].sort(() => Math.random() - 0.5);
const optionsFor = (correct, pool) => shuffle([correct, ...shuffle(pool.filter((x) => x !== correct)).slice(0, 3)]);

// Keyed by refId. In-memory only — fine for a mock; a real provider would
// have no server-side session at all (NIDA/telco own that state).
const sessions = new Map();

class MockNidaProvider extends KycProvider {
  async lookupIdentity(nidaNumber) {
    const h = hashCode(nidaNumber);
    const first = FIRST_NAMES[h % FIRST_NAMES.length];
    const last = LAST_NAMES[Math.floor(h / 7) % LAST_NAMES.length];
    const phoneLast4 = String(1000 + (h % 9000));
    const ward = WARDS[h % WARDS.length];
    const district = DISTRICTS[Math.floor(h / 3) % DISTRICTS.length];
    const region = REGIONS[Math.floor(h / 5) % REGIONS.length];
    const issueYear = String(2014 + (h % 11));

    const refId = crypto.randomUUID();
    sessions.set(refId, {
      record: { ward, district, region, issueYear },
      phoneLast4,
      otp: null,
      otpExpiresAt: null,
      kbvQuestions: null,
      attempts: 0,
    });

    return {
      refId,
      maskedName: `${maskName(first)} ${maskName(last)}`,
      maskedPhone: `+255 •• ••• ${phoneLast4}`,
      ward,
      district,
      region,
      issueYear,
    };
  }

  async sendOtp(refId) {
    const session = sessions.get(refId);
    if (!session) throw new Error("Unknown or expired KYC session");
    // Real provider: dispatch via SMS/USSD gateway to the MNO-registered number.
    session.otp = String(Math.floor(100000 + Math.random() * 900000));
    session.otpExpiresAt = Date.now() + 30_000;
    if (process.env.NODE_ENV !== "production") {
      console.log(`[MockNidaProvider] OTP for ${refId}: ${session.otp}`); // eslint-disable-line no-console
    }
    return { sent: true, expiresInSec: 30 };
  }

  async verifyOtp(refId, code) {
    const session = sessions.get(refId);
    if (!session || !session.otp) return false;
    session.attempts += 1;
    const ok = session.otp === code && Date.now() < session.otpExpiresAt;
    if (ok) sessions.delete(refId);
    return ok;
  }

  async getKbvQuestions(refId) {
    const session = sessions.get(refId);
    if (!session) throw new Error("Unknown or expired KYC session");
    const { record } = session;
    const yearPool = Array.from({ length: 11 }, (_, i) => String(2014 + i));
    const questions = [
      { id: "ward", prompt: "Which ward is listed on your NIDA record?", correct: record.ward, options: optionsFor(record.ward, WARDS) },
      { id: "region", prompt: "Which region issued your NIDA card?", correct: record.region, options: optionsFor(record.region, REGIONS) },
      { id: "issueYear", prompt: "What year was your NIDA card issued?", correct: record.issueYear, options: optionsFor(record.issueYear, yearPool) },
    ];
    session.kbvQuestions = questions;
    // Strip the correct answer before sending to the client.
    return questions.map(({ id, prompt, options }) => ({ id, prompt, options }));
  }

  async verifyKbv(refId, answers) {
    const session = sessions.get(refId);
    if (!session || !session.kbvQuestions) throw new Error("Call getKbvQuestions first");
    session.attempts += 1;
    const correctCount = session.kbvQuestions.filter((q) => answers[q.id] === q.correct).length;
    const passed = correctCount >= 2;
    if (passed) sessions.delete(refId);
    return { passed, correctCount };
  }
}

module.exports = { MockNidaProvider };
