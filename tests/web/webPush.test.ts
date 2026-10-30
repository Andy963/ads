import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import webPush from "web-push";

import { createWebPushStore } from "../../server/state/webPushStore.js";
import { handleWebPushRoutes } from "../../server/web/server/api/routes/webPush.js";
import type { ApiRouteContext } from "../../server/web/server/api/types.js";
import { createWebPushService, isAllowedWebPushEndpoint, webPushNotificationPayload } from "../../server/web/push/service.js";
import { createForegroundAwareWebPushNotifier } from "../../server/web/push/foregroundDelivery.js";

function routeContext(args: { method: string; path: string; userId?: string; body?: unknown }) {
  const body = args.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(args.body));
  const req = Object.assign(new EventEmitter(), {
    method: args.method,
    headers: { "content-type": "application/json" },
    async *[Symbol.asyncIterator]() { if (body.length) yield body; },
  });
  const res = Object.assign(new EventEmitter(), {
    statusCode: 0,
    body: "",
    headers: {} as Record<string, string>,
    setHeader(key: string, value: string) { this.headers[key.toLowerCase()] = value; },
    writeHead(status: number, headers: Record<string, string>) {
      this.statusCode = status;
      Object.assign(this.headers, headers);
    },
    end(value: string) { this.body = value; },
  });
  const url = new URL(args.path, "https://ads.test");
  return {
    req,
    res,
    pathname: url.pathname,
    url,
    auth: { userId: args.userId ?? "alice", username: args.userId ?? "alice" },
  };
}

function makeService(db: Database.Database, sendNotification?: typeof webPush.sendNotification) {
  const keys = webPush.generateVAPIDKeys();
  return createWebPushService({
    db,
    config: { ...keys, subject: "mailto:admin@example.com" },
    logger: { warn() {} },
    ...(sendNotification ? { sendNotification } : {}),
  });
}

const subscription = (token: string) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/${token}`,
  keys: { p256dh: "AbCd".repeat(20), auth: "Auth".repeat(5) },
});

describe("Web Push endpoint validation", () => {
  it("allows known HTTPS push services and rejects arbitrary destinations", () => {
    assert.equal(isAllowedWebPushEndpoint("https://web.push.apple.com/token"), true);
    assert.equal(isAllowedWebPushEndpoint("https://fcm.googleapis.com/fcm/send/token"), true);
    assert.equal(isAllowedWebPushEndpoint("http://fcm.googleapis.com/fcm/send/token"), false);
    assert.equal(isAllowedWebPushEndpoint("https://127.0.0.1/admin"), false);
    assert.equal(isAllowedWebPushEndpoint("https://fcm.googleapis.com.evil.test/send/token"), false);
    assert.equal(isAllowedWebPushEndpoint("https://user@fcm.googleapis.com/send/token"), false);
  });
});

describe("Web Push subscription routes", () => {
  it("stores subscriptions for the authenticated owner and never exposes the private VAPID key", async () => {
    const db = new Database(":memory:");
    try {
      const service = makeService(db);
      const saveAlice = routeContext({ method: "POST", path: "/api/web-push/subscription", body: subscription("alice-device") });
      await handleWebPushRoutes(saveAlice as unknown as ApiRouteContext, { service });
      assert.equal(saveAlice.res.statusCode, 200);

      const saveBob = routeContext({ method: "POST", path: "/api/web-push/subscription", userId: "bob", body: subscription("bob-device") });
      await handleWebPushRoutes(saveBob as unknown as ApiRouteContext, { service });

      const invalid = routeContext({
        method: "POST",
        path: "/api/web-push/subscription",
        body: { ...subscription("internal"), endpoint: "http://127.0.0.1/admin" },
      });
      await handleWebPushRoutes(invalid as unknown as ApiRouteContext, { service });
      assert.equal(invalid.res.statusCode, 400);

      const removeAsBob = routeContext({
        method: "POST",
        path: "/api/web-push/unsubscribe",
        userId: "bob",
        body: { endpoint: subscription("alice-device").endpoint },
      });
      await handleWebPushRoutes(removeAsBob as unknown as ApiRouteContext, { service });
      assert.equal(createWebPushStore(db).listByUser("alice").length, 1);
      assert.equal(createWebPushStore(db).listByUser("bob").length, 1);

      const config = routeContext({ method: "GET", path: "/api/web-push/config" });
      await handleWebPushRoutes(config as unknown as ApiRouteContext, { service });
      assert.equal(JSON.parse(config.res.body).enabled, true);
      assert.deepEqual(JSON.parse(config.res.body), { enabled: true, publicKey: service.publicKey });
    } finally {
      db.close();
    }
  });
});

describe("Web Push delivery", () => {
  it("removes permanently invalid subscriptions and keeps transient failures", async () => {
    const db = new Database(":memory:");
    try {
      const sent: Array<{ endpoint: string; payload?: string | Buffer | null }> = [];
      const warnings: string[] = [];
      const loggedService = createWebPushService({
        db,
        config: { ...webPush.generateVAPIDKeys(), subject: "mailto:admin@example.com" },
        logger: { warn: (message) => warnings.push(message) },
        sendNotification: async (item, payload) => {
          sent.push({ endpoint: item.endpoint, payload });
          const statusCode = Number(item.endpoint.split("/").at(-1));
          if (item.endpoint.endsWith("timeout")) throw new Error("timeout");
          throw Object.assign(new Error("delivery failed"), { statusCode });
        },
      });
      for (const status of [400, 401, 403, 404, 410]) {
        const current = subscription(String(status));
        loggedService.saveSubscription("alice", current);
        await assert.doesNotReject(loggedService.notifyUser("alice"));
        assert.deepEqual(createWebPushStore(db).listByUser("alice"), []);
      }
      for (const token of ["503", "timeout"]) {
        const current = subscription(token);
        loggedService.saveSubscription("alice", current);
        await assert.doesNotReject(loggedService.notifyUser("alice"));
        assert.deepEqual(createWebPushStore(db).listByUser("alice").map((entry) => entry.endpoint), [current.endpoint]);
      }

      assert.equal(sent.length, 7);
      assert.ok(sent.every((entry) => entry.payload === webPushNotificationPayload));
      assert.doesNotMatch(String(sent[0]?.payload), /conversation|assistant reply text/);
      assert.ok(warnings.every((message) => message.includes("endpoint=fcm.googleapis.com") && message.includes("status=")));
    } finally {
      db.close();
    }
  });

  it("sends only when the user has no open WebSocket client", async () => {
    const db = new Database(":memory:");
    try {
      let sendCount = 0;
      const service = makeService(db, async () => { sendCount += 1; });
      service.saveSubscription("alice", subscription("device"));
      let connected = true;
      const notify = createForegroundAwareWebPushNotifier({
        notifyUser: service.notifyUser,
        hasOpenWebClient: () => connected,
      });

      await notify("alice");
      assert.equal(sendCount, 0);
      connected = false;
      await notify("alice");
      assert.equal(sendCount, 1);
    } finally {
      db.close();
    }
  });

  it("keeps only the newest endpoint for each user", () => {
    const db = new Database(":memory:");
    try {
      const store = createWebPushStore(db);
      store.save("alice", subscription("old"));
      store.save("alice", subscription("new"));
      store.save("bob", subscription("bob"));

      assert.deepEqual(store.listByUser("alice").map((entry) => entry.endpoint), [subscription("new").endpoint]);
      assert.deepEqual(store.listByUser("bob").map((entry) => entry.endpoint), [subscription("bob").endpoint]);
    } finally {
      db.close();
    }
  });
});
