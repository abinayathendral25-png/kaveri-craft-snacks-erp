const TOKEN_KEY = 'ota_auth_token';
const OFFLINE_ORDERS_KEY = 'ota_offline_orders_v1';

export function getStoredToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export function setStoredToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export function formatRs(paisa) {
  const n = Number(paisa || 0) / 100;
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

export function formatBps(bps) {
  const n = Number(bps || 0) / 100;
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
}

export async function apiFetch(path, { method = 'GET', body = null, token = null } = {}) {
  const authToken = token ?? getStoredToken();
  const headers = {};
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  if (body !== null) headers['Content-Type'] = 'application/json';

  const res = await fetch(path, {
    method,
    headers,
    body: body !== null ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.details = data.details || null;
    throw err;
  }
  return data;
}

export function buildDownloadUrl(path) {
  const token = getStoredToken();
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}token=${encodeURIComponent(token)}`;
}

export function getOfflineQueue(username) {
  try {
    const raw = localStorage.getItem(`${OFFLINE_ORDERS_KEY}_${username}`);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveOfflineQueue(username, orders) {
  localStorage.setItem(`${OFFLINE_ORDERS_KEY}_${username}`, JSON.stringify(orders));
}

export function generateOfflineId(username) {
  return `mob-${username}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}
