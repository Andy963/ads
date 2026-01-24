import { createApp } from "vue";

import App from "./App.vue";

function readKeyboardTopPx(): number {
  const viewport = window.visualViewport;
  if (!viewport) {
    return Math.max(1, Math.round(window.innerHeight));
  }

  // visualViewport.height is the visible area; offsetTop shifts when the browser pans the visual viewport
  // (e.g. mobile keyboard, pinch-zoom). We want the keyboard top in layout viewport coordinates.
  const keyboardTop = viewport.height + viewport.offsetTop;
  const max = Math.max(1, Math.round(window.innerHeight));
  if (!Number.isFinite(keyboardTop)) {
    return max;
  }
  return Math.max(1, Math.min(max, Math.round(keyboardTop)));
}

let lastHeightPx = 0;
function applyViewportHeightPx(): void {
  const heightPx = readKeyboardTopPx();
  if (heightPx === lastHeightPx) return;
  lastHeightPx = heightPx;
  document.documentElement.style.setProperty("--app-height", `${heightPx}px`);
}

let heightRaf = 0;
function scheduleApplyViewportHeight(): void {
  if (heightRaf) cancelAnimationFrame(heightRaf);
  heightRaf = requestAnimationFrame(() => {
    heightRaf = 0;
    applyViewportHeightPx();
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
  scheduleApplyViewportHeight();
  for (const delay of [50, 150, 300, 500]) {
    window.setTimeout(scheduleApplyViewportHeight, delay);
  }
}

applyViewportHeightPx();
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
  applyViewportHeightPx();
}, 250);

createApp(App).mount("#app");
