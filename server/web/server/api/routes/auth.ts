import type http from "node:http";

import { z } from "zod";

import { getStateDatabase } from "../../../../state/database.js";
import { ensureWebAuthTables } from "../../../auth/schema.js";
import { verifyPasswordScrypt } from "../../../auth/password.js";
import {
  countUsers,
  createWebSession,
  findUserCredentialByUsername,
  revokeSessionByTokenHash,
} from "../../../auth/sessions.js";
import { authenticateRequest, buildClearSessionCookie, buildSessionCookie } from "../../auth.js";
import { getUserAgent, readJsonBody, resolveClientIp, sendJson } from "../../http.js";

export async function handleAuthRoutes(
  ctx: { req: http.IncomingMessage; res: http.ServerResponse; pathname: string },
  deps: { sessionTtlSeconds: number; sessionPepper: string },
): Promise<boolean> {
  const { req, res, pathname } = ctx;

  if (req.method === "GET" && pathname === "/api/auth/status") {
    sendJson(res, 200, { initialized: countUsers() > 0 });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/auth/login") {
    const body = await readJsonBody(req);
    const schema = z.object({ username: z.string().min(1), password: z.string().min(1) }).passthrough();
    const parsed = schema.safeParse(body ?? {});
    if (!parsed.success) {
      sendJson(res, 400, { error: "Invalid payload" });
      return true;
    }
    const username = parsed.data.username.trim();
    const password = parsed.data.password;

    const db = getStateDatabase();
    ensureWebAuthTables(db);
    const cred = findUserCredentialByUsername(db, username);
    if (!cred || cred.disabled_at) {
      sendJson(res, 401, { error: "Unauthorized" });
      return true;
    }
    if (!verifyPasswordScrypt(password, cred.password_hash)) {
      sendJson(res, 401, { error: "Unauthorized" });
      return true;
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const ip = resolveClientIp(req);
    const agent = getUserAgent(req);
    const created = createWebSession({
      userId: cred.id,
      nowSeconds,
      ttlSeconds: deps.sessionTtlSeconds,
      pepper: deps.sessionPepper,
      lastSeenIp: ip,
      userAgent: agent,
    });

    db.prepare("UPDATE web_users SET last_login_at = ?, updated_at = ? WHERE id = ?").run(nowSeconds, nowSeconds, cred.id);

    res.setHeader("Set-Cookie", buildSessionCookie(req, created.token, deps.sessionTtlSeconds));
    sendJson(res, 200, { success: true });
    return true;
  }

  if (pathname === "/api/auth/logout" && req.method === "POST") {
    const auth = authenticateRequest(req, deps);
    res.setHeader("Set-Cookie", buildClearSessionCookie(req));
    if (!auth.ok) {
      sendJson(res, 200, { success: true });
      return true;
    }
    revokeSessionByTokenHash({ tokenHash: auth.tokenHash });
    sendJson(res, 200, { success: true });
    return true;
  }

  if (pathname === "/api/auth/me" && req.method === "GET") {
    const auth = authenticateRequest(req, deps);
    if (!auth.ok) {
      sendJson(res, 401, { error: "Unauthorized" });
      return true;
    }
    if (auth.setCookie) {
      res.setHeader("Set-Cookie", auth.setCookie);
    }
    sendJson(res, 200, { id: auth.userId, username: auth.username });
    return true;
  }

  return false;
}
