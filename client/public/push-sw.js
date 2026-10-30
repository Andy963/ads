self.addEventListener("push", (event) => {
  const payload = (() => {
    try {
      return event.data ? event.data.json() : {};
    } catch {
      return {};
    }
  })();
  const isChinese = self.navigator.language.toLowerCase().startsWith("zh");
  const title = "ADS";
  const body = isChinese ? "助手已完成回复。" : "Your assistant has finished responding.";
  const scopeUrl = new URL(self.registration.scope);
  const iconUrl = new URL("pwa-192x192.png", scopeUrl).href;

  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: iconUrl,
    badge: iconUrl,
    data: { url: scopeUrl.href },
    tag: payload.type === "assistant_response" ? "assistant-response" : "ads-notification",
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
