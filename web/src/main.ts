import { createApp } from "vue";

import App from "./App.vue";

function readViewportMetrics(): { topPx: number; heightPx: number } {
  const viewport = window.visualViewport;
  if (!viewport) {
    return { topPx: 0, heightPx: Math.max(1, Math.round(window.innerHeight)) };
  }
  const topPx = Number.isFinite(viewport.offsetTop) ? Math.round(viewport.offsetTop) : 0;
  const heightPx = Number.isFinite(viewport.height) ? Math.max(1, Math.round(viewport.height)) : Math.max(1, Math.round(window.innerHeight));
  return { topPx, heightPx };
}

let lastMetrics = { topPx: Number.NaN, heightPx: Number.NaN };
function applyViewportVars(): void {
  const next = readViewportMetrics();
  if (next.topPx === lastMetrics.topPx && next.heightPx === lastMetrics.heightPx) return;
  lastMetrics = next;
  document.documentElement.style.setProperty("--app-top", `${next.topPx}px`);
  document.documentElement.style.setProperty("--app-height", `${next.heightPx}px`);
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

function scheduleBurst(): void {
  scheduleApplyViewportVars();
  for (const delay of [50, 150, 300, 500]) {
    window.setTimeout(scheduleApplyViewportVars, delay);
  }
}

applyViewportVars();
window.addEventListener("resize", scheduleBurst, { passive: true });
window.addEventListener("orientationchange", scheduleBurst, { passive: true });
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
