/**
 * Temporary on-device diagnostics. Surfaces errors that are otherwise swallowed
 * (Vue errorHandler, window error, unhandled rejections) plus suspicious code
 * paths, via alert() so they are perceptible on a real iPhone PWA.
 *
 * Rate-limited: each unique message alerts at most 3 times, with a global
 * budget, so an error loop can never freeze the app.
 *
 * TODO: remove this instrumentation once the root cause is confirmed.
 */
const seenCounts = new Map<string, number>();
let alertBudget = 20;

function summarize(detail: unknown): string {
  if (detail instanceof Error) return `${detail.name}: ${detail.message}`;
  if (typeof detail === "string") return detail;
  try {
    return JSON.stringify(detail) ?? String(detail);
  } catch {
    return String(detail);
  }
}

export function diagAlert(source: string, detail: unknown): void {
  try {
    if (typeof window === "undefined" || typeof window.alert !== "function") return;
    const text = summarize(detail).replace(/\s+/g, " ").trim().slice(0, 2600);
    if (!text) return;
    const key = `${source}::${text}`;
    const count = (seenCounts.get(key) ?? 0) + 1;
    seenCounts.set(key, count);
    if (count > 3 || alertBudget <= 0) return;
    alertBudget -= 1;
    window.alert(`[ADS诊断 ${count}/3] ${source}\n${text}`);
  } catch {
    // Diagnostics must never break the app.
  }
}
