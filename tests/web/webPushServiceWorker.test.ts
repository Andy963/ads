import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";

type ServiceWorkerEvent = {
  data?: { json: () => unknown };
  notification?: { close: () => void };
  waitUntil: (promise: Promise<unknown>) => void;
};

function loadServiceWorker(args: { language: string; clients: Array<Record<string, unknown>> }) {
  const handlers = new Map<string, (event: ServiceWorkerEvent) => void>();
  const notifications: Array<{ title: string; options: NotificationOptions }> = [];
  const openedUrls: string[] = [];
  const self = {
    navigator: { language: args.language },
    registration: {
      scope: "https://ads.example.test/app/",
      async showNotification(title: string, options: NotificationOptions) {
        notifications.push({ title, options });
      },
    },
    clients: {
      async matchAll() { return args.clients; },
      async openWindow(url: string) {
        openedUrls.push(url);
        return null;
      },
    },
    addEventListener(type: string, listener: (event: ServiceWorkerEvent) => void) {
      handlers.set(type, listener);
    },
  };
  const source = fs.readFileSync(new URL("../../client/public/push-sw.js", import.meta.url), "utf8");
  runInNewContext(source, { self, URL });
  return { handlers, notifications, openedUrls, self };
}

function eventWithWaitUntil(args: Omit<ServiceWorkerEvent, "waitUntil">) {
  let pending: Promise<unknown> | undefined;
  return {
    event: { ...args, waitUntil: (promise: Promise<unknown>) => { pending = promise; } },
    wait: async () => { await pending; },
  };
}

describe("Web Push service worker", () => {
  it("shows a generic localized notification only when no ADS window is visible", async () => {
    const visible = loadServiceWorker({ language: "en-US", clients: [{
      url: "https://ads.example.test/app/chat",
      visibilityState: "visible",
    }] });
    const visibleEvent = eventWithWaitUntil({ data: { json: () => ({ type: "assistant_response" }) } });
    visible.handlers.get("push")!(visibleEvent.event);
    await visibleEvent.wait();
    assert.equal(visible.notifications.length, 0);

    const hidden = loadServiceWorker({ language: "zh-CN", clients: [{
      url: "https://ads.example.test/app/chat",
      visibilityState: "hidden",
    }] });
    const hiddenEvent = eventWithWaitUntil({ data: { json: () => ({ type: "assistant_response" }) } });
    hidden.handlers.get("push")!(hiddenEvent.event);
    await hiddenEvent.wait();
    assert.equal(hidden.notifications[0]?.title, "ADS");
    assert.equal(hidden.notifications[0]?.options.body, "助手已完成回复。");
    assert.equal(hidden.notifications[0]?.options.icon, "https://ads.example.test/app/pwa-192x192.png");
    assert.equal(hidden.notifications[0]?.options.data.url, "https://ads.example.test/app/");
  });

  it("does not treat another app on the same origin as an ADS window", async () => {
    const worker = loadServiceWorker({ language: "en-US", clients: [{
      url: "https://ads.example.test/other-app/",
      visibilityState: "visible",
    }] });
    const push = eventWithWaitUntil({ data: { json: () => ({ type: "assistant_response" }) } });
    worker.handlers.get("push")!(push.event);
    await push.wait();

    assert.equal(worker.notifications.length, 1);
  });

  it("focuses an existing ADS window when the notification is clicked", async () => {
    const focused: string[] = [];
    const worker = loadServiceWorker({ language: "en-US", clients: [
      { url: "https://ads.example.test/other-app/", async focus() { focused.push("wrong-client"); } },
      { url: "https://ads.example.test/app/chat", async focus() { focused.push("focused"); } },
    ] });
    let closed = false;
    const click = eventWithWaitUntil({ notification: { close: () => { closed = true; } } });
    worker.handlers.get("notificationclick")!(click.event);
    await click.wait();

    assert.equal(closed, true);
    assert.deepEqual(focused, ["focused"]);
    assert.deepEqual(worker.openedUrls, []);
  });

  it("opens the ADS scope when no in-scope window exists", async () => {
    const worker = loadServiceWorker({ language: "en-US", clients: [{
      url: "https://ads.example.test/other-app/",
      async focus() { assert.fail("out-of-scope client must not be focused"); },
    }] });
    const click = eventWithWaitUntil({ notification: { close() {} } });
    worker.handlers.get("notificationclick")!(click.event);
    await click.wait();

    assert.deepEqual(worker.openedUrls, ["https://ads.example.test/app/"]);
  });
});
