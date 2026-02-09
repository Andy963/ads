import crypto from "node:crypto";

export type McpAuthContext = {
  version: 1;
  authUserId: string;
  sessionId: string;
  chatSessionId: string;
  historyKey: string;
  workspaceRoot: string;
  issuedAtMs: number;
  expiresAtMs: number;
};

export type McpAuthClaims = Omit<McpAuthContext, "version" | "issuedAtMs" | "expiresAtMs">;

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64url");
}

function base64UrlDecodeToBuffer(input: string): Buffer | null {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) return null;
  try {
    return Buffer.from(trimmed, "base64url");
  } catch {
    return null;
  }
}

function safeJsonParse(raw: string): unknown | null {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function computeHmac(payload: string, pepper: string): Buffer {
  return crypto.createHmac("sha256", pepper).update(payload).digest();
}

function timingSafeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function normalizeContext(input: unknown): McpAuthContext | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const obj = input as Record<string, unknown>;

  const version = obj.version === 1 ? 1 : null;
  if (version === null) return null;

  const authUserId = String(obj.authUserId ?? "").trim();
  const sessionId = String(obj.sessionId ?? "").trim();
  const chatSessionId = String(obj.chatSessionId ?? "").trim();
  const historyKey = String(obj.historyKey ?? "").trim();
  const workspaceRoot = String(obj.workspaceRoot ?? "").trim();
  const issuedAtMs = typeof obj.issuedAtMs === "number" && Number.isFinite(obj.issuedAtMs) ? Math.floor(obj.issuedAtMs) : 0;
  const expiresAtMs = typeof obj.expiresAtMs === "number" && Number.isFinite(obj.expiresAtMs) ? Math.floor(obj.expiresAtMs) : 0;

  if (!authUserId || !sessionId || !chatSessionId || !historyKey || !workspaceRoot) {
    return null;
  }
  if (issuedAtMs <= 0 || expiresAtMs <= 0 || expiresAtMs <= issuedAtMs) {
    return null;
  }

  return {
    version,
    authUserId,
    sessionId,
    chatSessionId,
    historyKey,
    workspaceRoot,
    issuedAtMs,
    expiresAtMs,
  };
}

export function createMcpBearerToken(options: {
  context: McpAuthClaims;
  pepper: string;
  nowMs?: number;
  ttlMs?: number;
}): string {
  const pepper = String(options.pepper ?? "").trim();
  if (!pepper) {
    throw new Error("pepper is required");
  }

  const nowMs = typeof options.nowMs === "number" && Number.isFinite(options.nowMs) ? Math.floor(options.nowMs) : Date.now();
  const ttlMs = typeof options.ttlMs === "number" && Number.isFinite(options.ttlMs)
    ? Math.max(1000, Math.floor(options.ttlMs))
    : 30 * 60 * 1000;

  const ctx: McpAuthContext = {
    version: 1,
    authUserId: String(options.context.authUserId ?? "").trim(),
    sessionId: String(options.context.sessionId ?? "").trim(),
    chatSessionId: String(options.context.chatSessionId ?? "").trim(),
    historyKey: String(options.context.historyKey ?? "").trim(),
    workspaceRoot: String(options.context.workspaceRoot ?? "").trim(),
    issuedAtMs: nowMs,
    expiresAtMs: nowMs + ttlMs,
  };

  const payload = JSON.stringify(ctx);
  const sig = computeHmac(payload, pepper);
  return `${base64UrlEncode(payload)}.${base64UrlEncode(sig)}`;
}

export function verifyMcpBearerToken(options: {
  token: string;
  pepper: string;
  nowMs?: number;
}): { ok: true; context: McpAuthContext } | { ok: false; error: string } {
  const pepper = String(options.pepper ?? "").trim();
  if (!pepper) {
    return { ok: false, error: "pepper_not_configured" };
  }

  const token = String(options.token ?? "").trim();
  const dot = token.indexOf(".");
  if (dot <= 0) {
    return { ok: false, error: "invalid_token_format" };
  }
  const payloadB64 = token.slice(0, dot).trim();
  const sigB64 = token.slice(dot + 1).trim();
  if (!payloadB64 || !sigB64) {
    return { ok: false, error: "invalid_token_format" };
  }

  const payloadBuf = base64UrlDecodeToBuffer(payloadB64);
  const sigBuf = base64UrlDecodeToBuffer(sigB64);
  if (!payloadBuf || !sigBuf) {
    return { ok: false, error: "invalid_token_encoding" };
  }

  const payload = payloadBuf.toString("utf8");
  const expected = computeHmac(payload, pepper);
  if (!timingSafeEqual(sigBuf, expected)) {
    return { ok: false, error: "invalid_token_signature" };
  }

  const parsed = safeJsonParse(payload);
  const ctx = normalizeContext(parsed);
  if (!ctx) {
    return { ok: false, error: "invalid_token_payload" };
  }

  const nowMs = typeof options.nowMs === "number" && Number.isFinite(options.nowMs) ? Math.floor(options.nowMs) : Date.now();
  if (ctx.expiresAtMs <= nowMs) {
    return { ok: false, error: "token_expired" };
  }

  return { ok: true, context: ctx };
}
