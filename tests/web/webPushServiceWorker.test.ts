import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";

type ServiceWorkerEvent = {
  data?: { json: () => unknown };
  notification?: { close: () => void };
  waitUntil: (promise: Promise<unknown>) => void;
};

function loadServiceWorker(args: {
  language: string;
  clients: Array<Record<string, unknown>>;
  fetch?: typeof fetch;
  subscription?: { toJSON: () => unknown };
}) {
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
      pushManager: {
        subscribe: async () => args.subscription,
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
  runInNewContext(source, { self, URL, fetch: args.fetch ?? fetch, atob });
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
  it("renders a fallback notification for legacy payloads", async () => {
    const visible = loadServiceWorker({ language: "en-US", clients: [{
      url: "https://ads.example.test/app/chat",
      visibilityState: "visible",
    }] });
    const visibleEvent = eventWithWaitUntil({ data: { json: () => ({ type: "assistant_response" }) } });
    visible.handlers.get("push")!(visibleEvent.event);
    await visibleEvent.wait();
    assert.equal(visible.notifications.length, 1);
    assert.equal(visible.notifications[0]?.title, "Reply complete");
    assert.equal(visible.notifications[0]?.options.body, "Acopilot");
    assert.equal(visible.notifications[0]?.options.tag, "assistant-response");

    const hidden = loadServiceWorker({ language: "zh-CN", clients: [{
      url: "https://ads.example.test/app/chat",
      visibilityState: "visible",
    }] });
    const hiddenEvent = eventWithWaitUntil({ data: { json: () => ({ type: "assistant_response" }) } });
    hidden.handlers.get("push")!(hiddenEvent.event);
    await hiddenEvent.wait();
    assert.equal(hidden.notifications[0]?.title, "回复完成");
    assert.equal(hidden.notifications[0]?.options.body, "Acopilot");
    assert.equal(hidden.notifications[0]?.options.icon, "https://ads.example.test/app/pwa-192x192.png");
    assert.equal(hidden.notifications[0]?.options.data.url, "https://ads.example.test/app/");
  });

  it("renders lane, project, outcome, and session-scoped tags", async () => {
    const worker = loadServiceWorker({ language: "zh-CN", clients: [] });
    const acopilot = eventWithWaitUntil({
      data: { json: () => ({ type: "assistant_response", lane: "acopilot", project: "ads", sessionId: "session-1" }) },
    });
    worker.handlers.get("push")!(acopilot.event);
    await acopilot.wait();

    const actions = eventWithWaitUntil({
      data: { json: () => ({ type: "prompt_error", lane: "actions", project: "ads", sessionId: "session-2" }) },
    });
    worker.handlers.get("push")!(actions.event);
    await actions.wait();

    assert.equal(worker.notifications[0]?.title, "回复完成");
    assert.equal(worker.notifications[0]?.options.body, "Acopilot · ads");
    assert.equal(worker.notifications[0]?.options.tag, "ads:assistant_response:acopilot:ads:session-1");
    assert.equal(worker.notifications[1]?.title, "执行失败");
    assert.equal(worker.notifications[1]?.options.body, "Actions · ads · 打开查看");
    assert.equal(worker.notifications[1]?.options.tag, "ads:prompt_error:actions:ads:session-2");
    assert.notEqual(worker.notifications[0]?.options.tag, worker.notifications[1]?.options.tag);
  });

  it("renders English failure copy for both lanes", async () => {
    const worker = loadServiceWorker({ language: "en-US", clients: [] });
    const actions = eventWithWaitUntil({
      data: { json: () => ({ type: "prompt_error", lane: "actions", project: "ads", sessionId: "session-2" }) },
    });
    worker.handlers.get("push")!(actions.event);
    await actions.wait();

    const acopilot = eventWithWaitUntil({
      data: { json: () => ({ type: "prompt_error", lane: "acopilot", project: "ads", sessionId: "session-3" }) },
    });
    worker.handlers.get("push")!(acopilot.event);
    await acopilot.wait();

    assert.equal(worker.notifications[0]?.title, "Run failed");
    assert.equal(worker.notifications[0]?.options.body, "Actions · ads · Open to view");
    assert.equal(worker.notifications[1]?.title, "Reply failed");
    assert.equal(worker.notifications[1]?.options.body, "Acopilot · ads · Open to view");
  });

  it("re-subscribes and registers the new endpoint after subscription rotation", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const subscription = { toJSON: () => ({ endpoint: "https://fcm.googleapis.com/new", keys: { p256dh: "key", auth: "auth" } }) };
    const worker = loadServiceWorker({
      language: "en-US",
      clients: [],
      subscription,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), init });
        return new Response(JSON.stringify({ enabled: true, publicKey: "AQID" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });
    const change = eventWithWaitUntil({});
    worker.handlers.get("pushsubscriptionchange")!(change.event);
    await change.wait();

    assert.equal(calls[0]?.url, "https://ads.example.test/app/api/web-push/config");
    assert.equal(calls[1]?.url, "https://ads.example.test/app/api/web-push/subscription");
    assert.equal(calls[1]?.init?.method, "POST");
    assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), subscription.toJSON());
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
