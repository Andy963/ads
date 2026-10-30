import type { z } from "zod";
import { z as zod } from "zod";

import { readJsonBody, sendJson } from "../../http.js";
import { isAllowedWebPushEndpoint } from "../../../push/service.js";
import type { ApiRouteContext } from "../types.js";

const subscriptionSchema = zod.object({
  endpoint: zod.string().min(1).max(4096),
  expirationTime: zod.number().nullable().optional(),
  keys: zod.object({
    p256dh: zod.string().min(40).max(128).regex(/^[A-Za-z0-9_-]+$/),
    auth: zod.string().min(16).max(64).regex(/^[A-Za-z0-9_-]+$/),
  }).strict(),
}).strict();

type WebPushService = {
  isConfigured: boolean;
  publicKey: string | null;
  saveSubscription: (userId: string, subscription: z.infer<typeof subscriptionSchema>) => void;
  removeSubscription: (userId: string, endpoint: string) => void;
};

export async function handleWebPushRoutes(
  ctx: ApiRouteContext,
  deps: { service: WebPushService },
): Promise<boolean> {
  const { req, res, pathname, auth } = ctx;

  if (pathname === "/api/web-push/config" && req.method === "GET") {
    sendJson(res, 200, { enabled: deps.service.isConfigured, publicKey: deps.service.publicKey });
    return true;
  }

  if (pathname === "/api/web-push/subscription" && req.method === "POST") {
    if (!deps.service.isConfigured) {
      sendJson(res, 503, { error: "Web Push is not configured on the server" });
      return true;
    }
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: "Invalid subscription" });
      return true;
    }
    const parsed = subscriptionSchema.safeParse(body);
    if (!parsed.success || !isAllowedWebPushEndpoint(parsed.data.endpoint)) {
      sendJson(res, 400, { error: "Invalid subscription" });
      return true;
    }
    deps.service.saveSubscription(auth.userId, parsed.data);
    sendJson(res, 200, { success: true });
    return true;
  }

  if (pathname === "/api/web-push/unsubscribe" && req.method === "POST") {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: "Invalid subscription endpoint" });
      return true;
    }
    const parsed = zod.object({ endpoint: zod.string().min(1).max(4096) }).strict().safeParse(body);
    const endpoint = parsed.success ? parsed.data.endpoint : "";
    if (!isAllowedWebPushEndpoint(endpoint)) {
      sendJson(res, 400, { error: "Invalid subscription endpoint" });
      return true;
    }
    deps.service.removeSubscription(auth.userId, endpoint);
    sendJson(res, 200, { success: true });
    return true;
  }

  return false;
}
