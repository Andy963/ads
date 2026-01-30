import type http from "node:http";

import { parseCookies, serializeCookie } from "../auth/cookies.js";
import {
  ADS_SESSION_COOKIE_NAME,
  lookupSessionByToken,
  refreshSessionIfNeeded,
} from "../auth/sessions.js";

export type RequestAuthContext =
  | { ok: true; userId: string; username: string; tokenHash: string; setCookie?: string }
  | { ok: false };

function isRequestSecure(req: http.IncomingMessage): boolean {
  const xfProto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim().toLowerCase() ?? "";
  if (xfProto === "https") {
    return true;
  }
  const forwarded = String(req.headers["forwarded"] ?? "").trim().toLowerCase();
  if (forwarded) {
    const match = /(?:^|;)\s*proto=([^;,\s]+)/.exec(forwarded);
    if (match && match[1] === "https") {
      return true;
    }
  }
  return false;
}

function resolveCookieSecure(req: http.IncomingMessage): boolean {
  const raw = String(process.env.ADS_WEB_COOKIE_SECURE ?? "").trim().toLowerCase();
  if (!raw || raw === "auto") {
    return isRequestSecure(req);
  }
  if (["1", "true", "yes", "on"].includes(raw)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(raw)) {
    return false;
  }
  return isRequestSecure(req);
}

export function readSessionCookie(req: http.IncomingMessage): string | null {
  const cookies = parseCookies(req.headers["cookie"]);
  const token = cookies[ADS_SESSION_COOKIE_NAME];
  const trimmed = String(token ?? "").trim();
  return trimmed || null;
}

export function buildSessionCookie(req: http.IncomingMessage, token: string, ttlSeconds: number): string {
  return serializeCookie(ADS_SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: resolveCookieSecure(req),
    sameSite: "Lax",
    path: "/",
    maxAgeSeconds: ttlSeconds,
  });
}

export function buildClearSessionCookie(req: http.IncomingMessage): string {
  return serializeCookie(ADS_SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    secure: resolveCookieSecure(req),
    sameSite: "Lax",
    path: "/",
    maxAgeSeconds: 0,
  });
}

export function authenticateRequest(
  req: http.IncomingMessage,
  options: { sessionTtlSeconds: number; sessionPepper: string },
): RequestAuthContext {
  const token = readSessionCookie(req);
  if (!token) {
    return { ok: false };
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const lookup = lookupSessionByToken({
    token,
    nowSeconds,
    ttlSeconds: options.sessionTtlSeconds,
    pepper: options.sessionPepper,
  });
  if (!lookup.ok) {
    return { ok: false };
  }

  const rawIp = req.headers["x-forwarded-for"];
  const firstIp = Array.isArray(rawIp) ? rawIp[0] : rawIp;
  const ip = String(firstIp ?? "").split(",")[0]?.trim() || (req.socket.remoteAddress ? String(req.socket.remoteAddress) : null);
  const rawAgent = req.headers["user-agent"];
  const agentValue = Array.isArray(rawAgent) ? rawAgent[0] : rawAgent;
  const agent = String(agentValue ?? "").trim() || null;

  const refreshed = refreshSessionIfNeeded({
    tokenHash: lookup.session.token_hash,
    nowSeconds,
    ttlSeconds: options.sessionTtlSeconds,
    lastSeenIp: ip,
    userAgent: agent,
    refresh: lookup.shouldRefresh,
  });
  void refreshed;

  const setCookie = lookup.shouldRefresh ? buildSessionCookie(req, token, options.sessionTtlSeconds) : undefined;
  return {
    ok: true,
    userId: lookup.user.id,
    username: lookup.user.username,
    tokenHash: lookup.session.token_hash,
    setCookie,
  };
}

