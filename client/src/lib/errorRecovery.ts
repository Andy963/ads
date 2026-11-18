/**
 * On-device recovery for render/patch crashes.
 *
 * Why reload instead of re-keying the lane panel: once a patch aborts mid-way,
 * the component subTree keeps vnodes whose el was never assigned (el=null).
 * Unmounting that bricked tree during a keyed remount walks those null els and
 * throws again (hostRemove(null) -> "null is not an object (evaluating
 * 'e.parentNode')"), so the remount itself dies and the session stays bricked.
 * A full page reload is the only reliable way out; diagnostics are already
 * persisted to localStorage before this runs, so the earliest error (with its
 * vnode tree dump) resurfaces on the next launch.
 *
 * Rate-limited via localStorage (sessionStorage does not reliably survive a
 * reload inside an iOS home-screen PWA), failing closed when storage is
 * unavailable so a deterministic boot-time crash can never loop the page.
 *
 * TODO: remove once the root cause is fixed and verified on device.
 */
import { ref } from "vue";

import { diagAlert } from "./diagAlert";

export const errorRecoveryGeneration = ref(0);

const RENDER_ERROR_PATTERN =
  /call stack|not an Object|is not an object|parentNode|nextSibling|emitsOptions|null is not|undefined is not/i;

const RELOAD_LOG_KEY = "ADS_RECOVERY_RELOADS";
const RELOAD_LOG_WINDOW_MS = 10 * 60 * 1000;
const RELOAD_LOG_LIMIT = 3;
const RELOAD_DELAY_MS = 350;

let reloadScheduled = false;

export function notifyRuntimeRenderError(error: unknown, info: unknown): boolean {
  const infoText = String(info ?? "");
  const message = error instanceof Error ? error.message : String(error ?? "");
  const looksRenderRelated =
    RENDER_ERROR_PATTERN.test(message) ||
    infoText.includes("15") ||
    /render|update|patch/i.test(infoText);
  if (!looksRenderRelated) return false;
  scheduleRecoveryReload();
  return true;
}

function scheduleRecoveryReload(): void {
  if (reloadScheduled) return;
  // The rate limit MUST be persisted with localStorage: sessionStorage is not
  // guaranteed to survive a reload in an iOS home-screen PWA, which turned this
  // into an infinite reload loop on device. Fail closed — if the log cannot be
  // read or written, do not reload at all.
  try {
    const now = Date.now();
    const log = (JSON.parse(localStorage.getItem(RELOAD_LOG_KEY) ?? "[]") as unknown[])
      .map((t) => Number(t))
      .filter((t) => Number.isFinite(t) && now - t < RELOAD_LOG_WINDOW_MS);
    if (log.length >= RELOAD_LOG_LIMIT) {
      diagAlert("渲染崩溃,自动刷新已达上限,请杀掉后台重开", { reloads: log.length });
      return;
    }
    log.push(now);
    localStorage.setItem(RELOAD_LOG_KEY, JSON.stringify(log));
  } catch {
    return;
  }
  reloadScheduled = true;
  window.setTimeout(() => {
    try {
      window.location.reload();
    } catch {
      // ignore
    }
  }, RELOAD_DELAY_MS);
}

export function resetRuntimeRecoveryForTests(): void {
  errorRecoveryGeneration.value = 0;
  reloadScheduled = false;
}
