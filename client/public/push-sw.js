self.addEventListener("push", (event) => {
  const payload = (() => {
    try {
      return event.data ? event.data.json() : {};
    } catch {
      return {};
    }
  })();
  const isChinese = self.navigator.language.toLowerCase().startsWith("zh");
  const lane = payload.lane === "actions" ? "actions" : "acopilot";
  const laneLabel = lane === "actions" ? "Actions" : "Acopilot";
  const project = typeof payload.project === "string" ? payload.project.trim().slice(0, 60) : "";
  const failed = payload.type === "prompt_error";
  const context = [laneLabel, project].filter(Boolean).join(" · ");
  const title = isChinese
    ? lane === "actions"
      ? failed ? "执行失败" : "执行完成"
      : failed ? "回复失败" : "回复完成"
    : lane === "actions"
      ? failed ? "Run failed" : "Run complete"
      : failed ? "Reply failed" : "Reply complete";
  const body = failed
    ? isChinese ? `${context} · 打开查看` : `${context} · Open to view`
    : context;
  const tag = payload.lane || payload.project || payload.sessionId
    ? ["ads", payload.type || "notification", payload.lane || "", payload.project || "", payload.sessionId || ""]
      .filter(Boolean)
      .map((part) => String(part).slice(0, 80))
      .join(":")
    : payload.type === "assistant_response" ? "assistant-response" : "ads-notification";
  const scopeUrl = new URL(self.registration.scope);
  const iconUrl = new URL("pwa-192x192.png", scopeUrl).href;

  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: iconUrl,
    badge: iconUrl,
    data: { url: scopeUrl.href },
    tag,
  }));
});

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    const configResponse = await fetch(new URL("api/web-push/config", self.registration.scope));
    if (!configResponse.ok) return;
    const config = await configResponse.json();
    if (!config.enabled || !config.publicKey) return;

    const paddedKey = config.publicKey.replace(/-/g, "+").replace(/_/g, "/")
      .padEnd(Math.ceil(config.publicKey.length / 4) * 4, "=");
    const keyBytes = Uint8Array.from(atob(paddedKey), (character) => character.charCodeAt(0));
    const subscription = await self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes,
    });
    await fetch(new URL("api/web-push/subscription", self.registration.scope), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(subscription),
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = new URL(self.registration.scope);
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    for (const client of clients) {
      const clientUrl = new URL(client.url);
      if (clientUrl.origin === targetUrl.origin && clientUrl.pathname.startsWith(targetUrl.pathname)) {
        return client.focus();
      }
    }
    return self.clients.openWindow(targetUrl.href);
  }));
});
