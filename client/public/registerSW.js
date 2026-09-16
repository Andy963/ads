if ("serviceWorker" in navigator) {
  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });

  function showUpdateToast(onAccept) {
    const toast = document.createElement("div");
    toast.setAttribute("role", "status");
    toast.style.cssText =
      "position:fixed;left:50%;bottom:calc(20px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);" +
      "z-index:9999;display:flex;align-items:center;gap:12px;padding:10px 10px 10px 16px;border-radius:14px;" +
      "background:rgba(15,23,42,.94);color:#f8fafc;font:500 13px/1.4 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;" +
      "box-shadow:0 10px 28px rgba(15,23,42,.35);";
    const text = document.createElement("span");
    text.textContent = "新版本已就绪";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "立即更新";
    button.style.cssText =
      "border:none;border-radius:9px;padding:7px 12px;background:#2563eb;color:#ffffff;" +
      "font:600 13px/1.4 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;cursor:pointer;";
    button.addEventListener("click", () => onAccept());
    toast.append(text, button);
    document.body.appendChild(toast);
  }

  function applyWaitingWorker(registration) {
    if (registration && registration.waiting) {
      registration.waiting.postMessage({ type: "SKIP_WAITING" });
      return true;
    }
    return false;
  }

  // A previously downloaded update is applied right away on cold start, before the
  // app becomes interactive, so the reload blends into the initial load instead of
  // flashing after the UI appears.
  navigator.serviceWorker
    .getRegistration("/")
    .then((registration) => applyWaitingWorker(registration))
    .catch(() => {});

  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then((registration) => {
        applyWaitingWorker(registration);
        registration.addEventListener("updatefound", () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            if (installing.state === "installed" && navigator.serviceWorker.controller) {
              // Mid-session updates no longer force a reload; the user chooses when.
              showUpdateToast(() => installing.postMessage({ type: "SKIP_WAITING" }));
            }
          });
        });
        return registration.update();
      })
      .catch(() => {
        // Service worker support is optional; the web app remains usable without it.
      });
  });
}
