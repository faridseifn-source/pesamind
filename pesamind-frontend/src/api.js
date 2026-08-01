// Drop this file in as `src/api.js` alongside PersonalFinanceApp.jsx.
// It's the only place that knows the backend exists — every component still
// works with the same plain-name shapes (category: "Food & Dining", wallet:
// "personal") it always did; this module translates at the boundary.
//
// Auth note: the refresh token lives in an httpOnly cookie set by the
// backend — this file never reads or stores it directly (JS can't read an
// httpOnly cookie, which is the point). Only the short-lived access token
// is held here, in memory, for the lifetime of the tab.

const BASE_URL = import.meta?.env?.VITE_API_URL || "https://pesamind-backend-n6z1.onrender.com";

let accessToken = null;

function setAccessToken(token) {
  accessToken = token || null;
}
function clearAccessToken() {
  accessToken = null;
}

async function raw(path, { method = "GET", body, auth = true, retry = true, extraHeaders = {} } = {}) {
  const headers = { "Content-Type": "application/json", ...extraHeaders };
  if (auth && accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    credentials: "include", // sends/receives the httpOnly refresh-token cookie
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && auth && retry) {
    const refreshed = await tryRefresh();
    if (refreshed) return raw(path, { method, body, auth, retry: false, extraHeaders });
  }

  if (res.status === 204) return null;

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed: ${res.status}`);
    err.status = res.status;
    err.details = data?.details;
    throw err;
  }
  return data;
}

// Generates a fresh key per logical operation. The caller is responsible for
// reusing the same key if it needs to safely retry a specific attempt —
// see cards.* below, where each user-initiated action gets one key.
const newIdempotencyKey = () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

async function tryRefresh() {
  try {
    const data = await raw("/auth/refresh", { method: "POST", auth: false });
    setAccessToken(data.accessToken);
    return true;
  } catch {
    clearAccessToken();
    return false;
  }
}

/* ------------------------------ auth ------------------------------ */

const auth = {
  async register({ firstName, lastName, email, phone, password }) {
    const data = await raw("/auth/register", { method: "POST", body: { firstName, lastName, email, phone, password }, auth: false });
    setAccessToken(data.accessToken);
    return data.user;
  },
  async login({ email, password }) {
    const data = await raw("/auth/login", { method: "POST", body: { email, password }, auth: false });
    setAccessToken(data.accessToken);
    return data.user;
  },
  async restoreSession() {
    const ok = await tryRefresh();
    if (!ok) return null;
    const { user } = await raw("/auth/me");
    return user;
  },
  async logout() {
    await raw("/auth/logout", { method: "POST", auth: false }).catch(() => {});
    clearAccessToken();
  },
  async updateProfile(patch) {
    const { user } = await raw("/users/me", { method: "PATCH", body: patch });
    return user;
  },
};

/* --------------------------- categories ---------------------------- */
// Backend: [{ id, name, color, subcategories:[{id,name}] }]
// Frontend expects the same shape (id is just extra, existing renders ignore it).

const categories = {
  async list() {
    const { categories } = await raw("/categories");
    return categories;
  },
  async create(name) {
    const { category } = await raw("/categories", { method: "POST", body: { name } });
    return category;
  },
  async rename(id, name) {
    const { category } = await raw(`/categories/${id}`, { method: "PATCH", body: { name } });
    return category;
  },
  async remove(id) {
    await raw(`/categories/${id}`, { method: "DELETE" });
  },
  async addSubcategory(categoryId, name) {
    const { subcategory } = await raw(`/categories/${categoryId}/subcategories`, { method: "POST", body: { name } });
    return subcategory;
  },
  async renameSubcategory(subId, name) {
    const { subcategory } = await raw(`/categories/subcategories/${subId}`, { method: "PATCH", body: { name } });
    return subcategory;
  },
  async removeSubcategory(subId) {
    await raw(`/categories/subcategories/${subId}`, { method: "DELETE" });
  },
};

/* ----------------------------- wallets ------------------------------ */

const wallets = {
  async list() {
    const { wallets } = await raw("/wallets");
    return wallets; // [{ id, type: "PERSONAL"|"SHARED", name, members }]
  },
};

/* --------------------------- transactions ---------------------------- */
// Frontend tx shape: { id, amount, merchant, category, subcategory, date, wallet, loggedBy }
// Backend tx shape:  { id, amount, merchant, categoryId, category:{name}, subcategoryId, subcategory:{name}, date, walletId, loggedByName }

function toFrontendTx(t, walletTypeById) {
  return {
    id: t.id,
    amount: Number(t.amount),
    merchant: t.merchant,
    category: t.category?.name,
    subcategory: t.subcategory?.name || null,
    date: t.date.slice(0, 10),
    wallet: walletTypeById[t.walletId] === "SHARED" ? "shared" : "personal",
    loggedBy: t.loggedByName,
    note: t.note || undefined,
    photoUrl: t.photoUrl || undefined,
  };
}

function toBackendTxInput({ tx, categoryIdByName, subcategoryIdByName, walletIdByType, source }) {
  return {
    walletId: walletIdByType[tx.wallet] || walletIdByType.personal,
    categoryId: categoryIdByName[tx.category],
    subcategoryId: tx.subcategory ? subcategoryIdByName[tx.subcategory] || null : null,
    amount: tx.amount,
    merchant: tx.merchant,
    note: tx.note || null,
    photoUrl: tx.photoUrl || null,
    date: new Date(tx.date || Date.now()).toISOString(),
    source: source || "manual",
  };
}

const transactions = {
  async list({ walletTypeById }) {
    const { transactions } = await raw("/transactions");
    return transactions.map((t) => toFrontendTx(t, walletTypeById));
  },
  async create(tx, ctx) {
    const body = toBackendTxInput({ tx, ...ctx });
    const { transaction } = await raw("/transactions", { method: "POST", body });
    return toFrontendTx(transaction, ctx.walletTypeById);
  },
  async createMany(txs, ctx) {
    const body = txs.map((tx) => toBackendTxInput({ tx, ...ctx }));
    const { transactions } = await raw("/transactions/bulk", { method: "POST", body: { transactions: body } });
    return transactions.map((t) => toFrontendTx(t, ctx.walletTypeById));
  },
  async update(id, patch, ctx) {
    const body = {};
    if (patch.amount !== undefined) body.amount = patch.amount;
    if (patch.merchant !== undefined) body.merchant = patch.merchant;
    if (patch.date !== undefined) body.date = new Date(patch.date).toISOString();
    if (patch.category !== undefined) body.categoryId = ctx.categoryIdByName[patch.category];
    if (patch.subcategory !== undefined) body.subcategoryId = patch.subcategory ? ctx.subcategoryIdByName[patch.subcategory] : null;
    const { transaction } = await raw(`/transactions/${id}`, { method: "PATCH", body });
    return toFrontendTx(transaction, ctx.walletTypeById);
  },
  async remove(id) {
    await raw(`/transactions/${id}`, { method: "DELETE" });
  },
  async removeMany(ids) {
    await raw("/transactions/bulk-delete", { method: "POST", body: { ids } });
  },
};

/* ----------------------------- budgets ------------------------------ */
// Frontend shape: { category: name, limit }. Backend: { id, categoryId, category:{name}, limit }.

const budgets = {
  async list() {
    const { budgets } = await raw("/budgets");
    return budgets.map((b) => ({ id: b.id, category: b.category.name, categoryId: b.categoryId, limit: Number(b.limit) }));
  },
  async upsert(categoryId, limit, period = "monthly") {
    const { budget } = await raw("/budgets", { method: "PUT", body: { categoryId, limit, period } });
    return { id: budget.id, category: budget.category.name, categoryId: budget.categoryId, limit: Number(budget.limit) };
  },
  async remove(id) {
    await raw(`/budgets/${id}`, { method: "DELETE" });
  },
};

/* ------------------------------- kyc --------------------------------- */

const kyc = {
  status: () => raw("/kyc/status"),
  lookup: (nidaNumber) => raw("/kyc/lookup", { method: "POST", body: { nidaNumber } }), // -> { maskedName, maskedPhone }
  sendOtp: () => raw("/kyc/otp/send", { method: "POST" }), // -> { sent, expiresInSec }
  verifyOtp: (code) => raw("/kyc/otp/verify", { method: "POST", body: { code } }), // -> { verified }
  kbvQuestions: () => raw("/kyc/kbv/questions"), // -> { questions }
  verifyKbv: (answers) => raw("/kyc/kbv/verify", { method: "POST", body: { answers } }), // -> { verified, correctCount }
};

/* ------------------------------- cards -------------------------------- */

const cards = {
  me: () => raw("/cards/me"), // -> { card, activity }
  freeze: (frozen) => raw("/cards/freeze", { method: "POST", body: { frozen } }),
  controls: (controls) => raw("/cards/controls", { method: "POST", body: controls }),
  dailyLimit: (dailyLimit) => raw("/cards/daily-limit", { method: "POST", body: { dailyLimit } }),
  topupGateway: (paymentToken, amount) => raw("/cards/topup/gateway", { method: "POST", body: { paymentToken, amount }, extraHeaders: { "Idempotency-Key": newIdempotencyKey() } }),
  topupOct: (paymentToken, amount) => raw("/cards/topup/oct", { method: "POST", body: { paymentToken, amount }, extraHeaders: { "Idempotency-Key": newIdempotencyKey() } }),
  resolveLipa: (destination) => raw("/cards/pay/lipa/resolve", { method: "POST", body: { destination } }),
  payLipa: (destination, amount, categoryId) => raw("/cards/pay/lipa", { method: "POST", body: { destination, amount, categoryId }, extraHeaders: { "Idempotency-Key": newIdempotencyKey() } }),
  payGepg: (control, amount, biller, categoryId) => raw("/cards/pay/gepg", { method: "POST", body: { control, amount, biller, categoryId }, extraHeaders: { "Idempotency-Key": newIdempotencyKey() } }),
  payLuku: (meter, amount, categoryId) => raw("/cards/pay/luku", { method: "POST", body: { meter, amount, categoryId }, extraHeaders: { "Idempotency-Key": newIdempotencyKey() } }),
};

/* --------------------------- notifications ----------------------------- */

const notifications = {
  list: () => raw("/notifications").then((d) => d.notifications),
  markRead: (id) => raw(`/notifications/${id}/read`, { method: "POST" }),
  markAllRead: () => raw("/notifications/read-all", { method: "POST" }),
};

export const api = { auth, categories, wallets, transactions, budgets, kyc, cards, notifications, clearAccessToken };
