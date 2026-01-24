import { createApp } from "vue";

import App from "./App.vue";

function readViewportMetrics(): { topPx: number; bottomPx: number } {
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

let lastMetrics = { topPx: Number.NaN, bottomPx: Number.NaN, keyboardOpen: false };
function applyViewportVars(): void {
  const next = readViewportMetrics();
  const keyboardOpen = isTextInput(document.activeElement) && next.bottomPx > 0;
  if (
    next.topPx === lastMetrics.topPx &&
    next.bottomPx === lastMetrics.bottomPx &&
    keyboardOpen === lastMetrics.keyboardOpen
  ) {
    return;
  }
  if (next.topPx !== lastMetrics.topPx) {
    document.documentElement.style.setProperty("--app-top", `${next.topPx}px`);
  }
  if (next.bottomPx !== lastMetrics.bottomPx) {
    document.documentElement.style.setProperty("--app-bottom", `${next.bottomPx}px`);
  }
  if (keyboardOpen !== lastMetrics.keyboardOpen) {
    document.documentElement.style.setProperty("--safe-bottom-multiplier", keyboardOpen ? "0" : "1");
  }
  lastMetrics = { ...next, keyboardOpen };
}

let heightRaf = 0;
function scheduleApplyViewportVars(): void {
  if (heightRaf) cancelAnimationFrame(heightRaf);
  heightRaf = requestAnimationFrame(() => {
    heightRaf = 0;
    applyViewportVars();
  });
}

function isTextInput(el: unknown): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  const type = String((el as HTMLInputElement).type || "text").toLowerCase();
  return ![
    "button",
    "submit",
    "reset",
    "checkbox",
    "radio",
    "range",
    "color",
    "file",
    "image",
    "hidden",
  ].includes(type);
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

applyViewportVars();
window.addEventListener("resize", scheduleBurst, { passive: true });
window.addEventListener("orientationchange", scheduleBurst, { passive: true });
window.addEventListener("scroll", scheduleBurst, { passive: true });
window.visualViewport?.addEventListener("resize", scheduleBurst, { passive: true });
window.visualViewport?.addEventListener("scroll", scheduleBurst, { passive: true });
document.addEventListener(
  "focusin",
  (ev) => {
    if (isTextInput(ev.target)) scheduleBurst();
  },
  { passive: true },
);
document.addEventListener(
  "focusout",
  (ev) => {
    if (isTextInput(ev.target)) scheduleBurst();
  },
  { passive: true },
);

// Some mobile browsers don't reliably fire resize events when the keyboard is dismissed
// (e.g. Android back gesture). Poll while a text field is focused to keep the viewport height in sync.
window.setInterval(() => {
  const active = document.activeElement;
  if (!isTextInput(active)) return;
  applyViewportVars();
}, 250);

createApp(App).mount("#app");
