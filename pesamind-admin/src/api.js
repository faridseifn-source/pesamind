// Same backend as the customer app — the admin API is just a different,
// role-gated set of routes on it, not a separate service.
const BASE_URL = import.meta?.env?.VITE_API_URL || "https://pesamind-backend-n6z1.onrender.com";

let accessToken = null;
export function setAccessToken(token) { accessToken = token; }
export function clearAccessToken() { accessToken = null; }

let refreshPromise = null;
async function tryRefresh() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = fetch(`${BASE_URL}/admin/auth/refresh`, { method: "POST", credentials: "include" })
    .then(async (r) => {
      if (!r.ok) return false;
      const data = await r.json();
      setAccessToken(data.accessToken);
      return true;
    })
    .catch(() => false)
    .finally(() => { refreshPromise = null; });
  return refreshPromise;
}

const NO_RETRY_PATHS = ["/admin/auth/refresh", "/admin/auth/login", "/admin/auth/verify"];

async function raw(path, { method = "GET", body, retried = false } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    credentials: "include", // sends the httpOnly admin refresh cookie
    headers: {
      "Content-Type": "application/json",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && !retried && !NO_RETRY_PATHS.includes(path)) {
    const refreshed = await tryRefresh();
    if (refreshed) return raw(path, { method, body, retried: true });
  }

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const data = await res.json();
      message = data.error || data.message || message;
    } catch {
      // non-JSON error body — keep the generic message
    }
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

const qs = (params = {}) => {
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ""));
  return new URLSearchParams(clean).toString();
};

export const adminApi = {
  auth: {
    login: (email, password) => raw("/admin/auth/login", { method: "POST", body: { email, password } }),
    verify: (challengeId, code) => raw("/admin/auth/verify", { method: "POST", body: { challengeId, code } }).then((d) => { setAccessToken(d.accessToken); return d; }),
    me: () => raw("/admin/auth/me"),
    logout: async () => { try { await raw("/admin/auth/logout", { method: "POST" }); } finally { clearAccessToken(); } },
    restoreSession: tryRefresh,
  },

  dashboard: () => raw("/admin/dashboard"),

  users: {
    list: (search, page = 1, pageSize = 25) => raw(`/admin/users?${qs({ search, page, pageSize })}`),
    get: (id) => raw(`/admin/users/${id}`),
    overview: (id) => raw(`/admin/users/${id}/overview`),
    kyc: (id) => raw(`/admin/users/${id}/kyc`),
    transactions: (id, search, limit = 30) => raw(`/admin/users/${id}/transactions?${qs({ search, limit })}`).then((d) => d.transactions),
    statement: (id, from, to) => raw(`/admin/users/${id}/statement?${qs({ from, to })}`),
    block: (id, reason) => raw(`/admin/users/${id}/block`, { method: "POST", body: { reason } }),
    unblock: (id) => raw(`/admin/users/${id}/unblock`, { method: "POST" }),
  },

  tickets: {
    list: (filters = {}, page = 1, pageSize = 25) => raw(`/admin/tickets?${qs({ ...filters, page, pageSize })}`),
    create: (data) => raw("/admin/tickets", { method: "POST", body: data }),
    update: (id, data) => raw(`/admin/tickets/${id}`, { method: "PATCH", body: data }),
  },

  settings: {
    list: () => raw("/admin/settings").then((d) => d.settings),
    update: (key, value) => raw(`/admin/settings/${key}`, { method: "PATCH", body: { value } }),
  },

  auditLogs: (filters = {}, page = 1, pageSize = 25) => raw(`/admin/audit-logs?${qs({ ...filters, page, pageSize })}`),
};
