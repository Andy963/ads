import webPush from "web-push";

import type { Database as DatabaseType } from "better-sqlite3";
import { createWebPushStore, type StoredWebPushSubscription } from "../../state/webPushStore.js";

export type WebPushConfig = {
  publicKey?: string;
  privateKey?: string;
  subject?: string;
};

export type WebPushLogger = {
  warn: (message: string) => void;
};

export const webPushNotificationPayload = JSON.stringify({ type: "assistant_response" });

export function isAllowedWebPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }

  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  return host === "web.push.apple.com"
    || host === "fcm.googleapis.com"
    || host === "updates.push.services.mozilla.com"
    || host === "push.services.mozilla.com"
    || host.endsWith(".notify.windows.com");
}

function resolveStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("statusCode" in error)) return undefined;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" ? statusCode : undefined;
}

export function createWebPushService(args: {
  db: DatabaseType;
  config: WebPushConfig;
  logger: WebPushLogger;
  sendNotification?: typeof webPush.sendNotification;
}) {
  const store = createWebPushStore(args.db);
  const publicKey = args.config.publicKey?.trim() ?? "";
  const privateKey = args.config.privateKey?.trim() ?? "";
  const subject = args.config.subject?.trim() ?? "";
  let configured = false;

  if (publicKey && privateKey && subject) {
    try {
      webPush.setVapidDetails(subject, publicKey, privateKey);
      configured = true;
    } catch {
      args.logger.warn("[WebPush] Invalid VAPID configuration; notifications are disabled");
    }
  }

  const sendNotification = args.sendNotification ?? webPush.sendNotification;

  return {
    isConfigured: configured,
    publicKey: configured ? publicKey : null,

    saveSubscription(userId: string, subscription: StoredWebPushSubscription): void {
      store.save(userId, subscription);
    },

    removeSubscription(userId: string, endpoint: string): void {
      store.remove(userId, endpoint);
    },

    async notifyUser(userId: string): Promise<void> {
      if (!configured) return;
      const subscriptions = store.listByUser(userId);
      await Promise.all(subscriptions.map(async (subscription) => {
        try {
          await sendNotification(subscription, webPushNotificationPayload, { TTL: 60, urgency: "low", timeout: 10_000 });
        } catch (error) {
          const statusCode = resolveStatusCode(error);
          if (statusCode === 400 || statusCode === 401 || statusCode === 403 || statusCode === 404 || statusCode === 410) {
            store.remove(userId, subscription.endpoint);
          }
          let endpointHost = "unknown";
          try {
            endpointHost = new URL(subscription.endpoint).host;
          } catch {
            // Invalid stored endpoints should still be reported without exposing the full endpoint.
          }
          args.logger.warn(`[WebPush] Delivery failed endpoint=${endpointHost} status=${statusCode ?? "unknown"}`);
        }
      }));
    },
  };
}
