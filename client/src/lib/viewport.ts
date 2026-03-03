import { isTextInputElement } from "./dom";

type ViewportMetrics = { topPx: number; bottomPx: number };

function readViewportMetrics(): ViewportMetrics {
  const layoutHeightPx = Math.max(1, Math.round(window.innerHeight));
  const viewport = window.visualViewport;
  if (!viewport) {
    return { topPx: 0, bottomPx: 0 };
  }
  const topPx = Number.isFinite(viewport.offsetTop) ? Math.max(0, Math.round(viewport.offsetTop)) : 0;
  const heightPx = Number.isFinite(viewport.height) ? Math.max(1, Math.round(viewport.height)) : layoutHeightPx;
  const bottomPx = Math.max(0, layoutHeightPx - topPx - heightPx);
  return { topPx, bottomPx };
}

type MetricsState = { topPx: number; bottomPx: number; keyboardOpen: boolean };

let lastMetrics: MetricsState = { topPx: Number.NaN, bottomPx: Number.NaN, keyboardOpen: false };
function applyViewportVars(): void {
  const next = readViewportMetrics();
  const keyboardOpen = isTextInputElement(document.activeElement) && next.bottomPx > 0;
  // Only shrink the fixed app container when the on-screen keyboard is open.
  // Some browsers report a non-zero visualViewport bottom inset even when the keyboard is closed,
  // which created a persistent blank area under the composer.
  const appTopPx = keyboardOpen ? next.topPx : 0;
  const appBottomPx = keyboardOpen ? next.bottomPx : 0;
  if (
    appTopPx === lastMetrics.topPx &&
    appBottomPx === lastMetrics.bottomPx &&
    keyboardOpen === lastMetrics.keyboardOpen
  ) {
    return;
  }
  if (appTopPx !== lastMetrics.topPx) {
    document.documentElement.style.setProperty("--app-top", `${appTopPx}px`);
  }
  if (appBottomPx !== lastMetrics.bottomPx) {
    document.documentElement.style.setProperty("--app-bottom", `${appBottomPx}px`);
  }
  if (keyboardOpen !== lastMetrics.keyboardOpen) {
    document.documentElement.style.setProperty("--safe-bottom-multiplier", keyboardOpen ? "0" : "1");
  }
  lastMetrics = { topPx: appTopPx, bottomPx: appBottomPx, keyboardOpen };
}

let heightRaf = 0;
function scheduleApplyViewportVars(): void {
  if (heightRaf) cancelAnimationFrame(heightRaf);
  heightRaf = requestAnimationFrame(() => {
    heightRaf = 0;
    applyViewportVars();
  });
}

function resetWindowScroll(): void {
  if (window.scrollX !== 0 || window.scrollY !== 0) {
    window.scrollTo(0, 0);
  }
  const docEl = document.documentElement;
  if (docEl.scrollLeft !== 0) docEl.scrollLeft = 0;
  if (docEl.scrollTop !== 0) docEl.scrollTop = 0;
  const body = document.body;
  if (body.scrollLeft !== 0) body.scrollLeft = 0;
  if (body.scrollTop !== 0) body.scrollTop = 0;
}

function scheduleBurst(): void {
  resetWindowScroll();
  scheduleApplyViewportVars();
  for (const delay of [50, 150, 300, 500, 800, 1200, 1800]) {
    window.setTimeout(scheduleApplyViewportVars, delay);
  }
}

let installed = false;

export function installViewportCssVars(): void {
  if (installed) return;
  installed = true;

  applyViewportVars();
  window.addEventListener("resize", scheduleBurst, { passive: true });
  window.addEventListener("orientationchange", scheduleBurst, { passive: true });
  window.addEventListener("scroll", scheduleBurst, { passive: true });
  window.visualViewport?.addEventListener("resize", scheduleBurst, { passive: true });
  window.visualViewport?.addEventListener("scroll", scheduleBurst, { passive: true });
  document.addEventListener(
    "focusin",
    (ev) => {
      if (isTextInputElement(ev.target)) scheduleBurst();
    },
    { passive: true },
  );
  document.addEventListener(
    "focusout",
    (ev) => {
      if (isTextInputElement(ev.target)) scheduleBurst();
    },
    { passive: true },
  );

  // Some mobile browsers don't reliably fire resize events when the keyboard is dismissed
  // (e.g. Android back gesture). Poll while a text field is focused to keep the viewport height in sync.
  window.setInterval(() => {
    const active = document.activeElement;
    if (!isTextInputElement(active)) return;
    applyViewportVars();
  }, 250);
}

