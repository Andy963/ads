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

  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    if (clients.some((client) => {
      const clientUrl = new URL(client.url);
      return clientUrl.origin === scopeUrl.origin
        && clientUrl.pathname.startsWith(scopeUrl.pathname)
        && client.visibilityState === "visible";
    })) return;
    return self.registration.showNotification(title, {
      body,
      icon: iconUrl,
      badge: iconUrl,
      data: { url: scopeUrl.href },
      tag: payload.type === "assistant_response" ? "assistant-response" : "ads-notification",
    });
  }));
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
