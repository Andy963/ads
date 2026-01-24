import { createApp } from "vue";

import App from "./App.vue";

function setAppHeightPx(): void {
  if (typeof window === "undefined") return;
  const viewport = window.visualViewport;
  const height = viewport?.height ?? window.innerHeight;
  const width = viewport?.width ?? window.innerWidth;
  const offsetTop = viewport?.offsetTop ?? 0;
  const offsetLeft = viewport?.offsetLeft ?? 0;
  document.documentElement.style.setProperty("--app-height", `${Math.max(1, Math.round(height))}px`);
  document.documentElement.style.setProperty("--app-width", `${Math.max(1, Math.round(width))}px`);
  document.documentElement.style.setProperty("--app-top", `${Math.round(offsetTop)}px`);
  document.documentElement.style.setProperty("--app-left", `${Math.round(offsetLeft)}px`);
}

let heightRaf = 0;
function scheduleSetAppHeight(): void {
  if (typeof window === "undefined") return;
  if (heightRaf) cancelAnimationFrame(heightRaf);
  heightRaf = requestAnimationFrame(() => {
    heightRaf = 0;
    setAppHeightPx();
  });
}

setAppHeightPx();
window.addEventListener("resize", scheduleSetAppHeight);
window.addEventListener("orientationchange", scheduleSetAppHeight);
window.visualViewport?.addEventListener("resize", scheduleSetAppHeight);
window.visualViewport?.addEventListener("scroll", scheduleSetAppHeight);
document.addEventListener("focusin", scheduleSetAppHeight);
document.addEventListener("focusout", scheduleSetAppHeight);

createApp(App).mount("#app");
