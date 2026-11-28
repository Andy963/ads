const AGY_PENDING_LOGIN_KEY = "ads:agyPendingLoginView";
// Keep in sync with server ACTIVE_LOGIN_TTL (10 minutes).
export const AGY_PENDING_LOGIN_TTL_MS = 10 * 60 * 1000;

export function markPendingAgyLoginView(): void {
  try {
    localStorage.setItem(AGY_PENDING_LOGIN_KEY, JSON.stringify({ ts: Date.now() }));
  } catch {
    // Storage may be unavailable in restricted contexts.
  }
}

export function clearPendingAgyLoginView(): void {
  try {
    localStorage.removeItem(AGY_PENDING_LOGIN_KEY);
  } catch {
    // ignore
  }
}

export function hasPendingAgyLoginView(now = Date.now()): boolean {
  try {
    const raw = localStorage.getItem(AGY_PENDING_LOGIN_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { ts?: unknown };
    const ts = Number(parsed?.ts ?? 0);
    if (!Number.isFinite(ts) || ts <= 0 || now - ts > AGY_PENDING_LOGIN_TTL_MS) {
      localStorage.removeItem(AGY_PENDING_LOGIN_KEY);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
