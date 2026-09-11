import { isTextInputElement } from "./dom";

type ViewportMetrics = { topPx: number; bottomPx: number; heightPx: number; leftPx: number; widthPx: number };

export function readViewportMetrics(): ViewportMetrics {
  const layoutHeightPx = Math.max(1, Math.round(window.innerHeight));
  const viewport = window.visualViewport;
  if (!viewport) {
    return { topPx: 0, bottomPx: 0, heightPx: layoutHeightPx, leftPx: 0, widthPx: window.innerWidth };
  }
  const topPx = Number.isFinite(viewport.offsetTop) ? Math.max(0, Math.round(viewport.offsetTop)) : 0;
  const heightPx = Number.isFinite(viewport.height) ? Math.max(1, Math.round(viewport.height)) : layoutHeightPx;
  const bottomPx = Math.max(0, layoutHeightPx - topPx - heightPx);
  const leftPx = Number.isFinite(viewport.offsetLeft) ? Math.max(0, viewport.offsetLeft) : 0;
  const widthPx = Number.isFinite(viewport.width) ? Math.max(1, viewport.width) : window.innerWidth;
  return { topPx, bottomPx, heightPx, leftPx, widthPx };
}

type MetricsState = { topPx: number; bottomPx: number; heightPx: number };

let lastMetrics: MetricsState = {
  topPx: Number.NaN,
  bottomPx: Number.NaN,
  heightPx: Number.NaN,
};
function applyViewportVars(): void {
  const next = readViewportMetrics();
  const heightPx = next.heightPx;
  const appTopPx = next.topPx;
  const appBottomPx = next.bottomPx;
  if (
    appTopPx === lastMetrics.topPx &&
    appBottomPx === lastMetrics.bottomPx &&
    heightPx === lastMetrics.heightPx
  ) {
    return;
  }
  if (appTopPx !== lastMetrics.topPx) {
    document.documentElement.style.setProperty("--app-top", `${appTopPx}px`);
  }
  if (appBottomPx !== lastMetrics.bottomPx) {
    document.documentElement.style.setProperty("--app-bottom", `${appBottomPx}px`);
  }
  if (heightPx !== lastMetrics.heightPx) {
    document.documentElement.style.setProperty("--ads-visual-viewport-height", `${heightPx}px`);
  }
  lastMetrics = { topPx: appTopPx, bottomPx: appBottomPx, heightPx };
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
  window.addEventListener("pageshow", scheduleBurst, { passive: true });
  window.addEventListener("resize", scheduleBurst, { passive: true });
  window.addEventListener("orientationchange", scheduleBurst, { passive: true });
  window.addEventListener("scroll", scheduleBurst, { passive: true });
  window.visualViewport?.addEventListener("resize", scheduleBurst, { passive: true });
  window.visualViewport?.addEventListener("scroll", scheduleBurst, { passive: true });
  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.visibilityState === "visible") scheduleBurst();
    },
    { passive: true },
  );
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

  // Mobile browsers can omit the final resize after blur or browser toolbar
  // animations. Poll visible pages even after the text field loses focus.
  window.setInterval(() => {
    if (document.visibilityState !== "visible") return;
    applyViewportVars();
  }, 250);
}
