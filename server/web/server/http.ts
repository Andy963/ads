import type http from "node:http";

export function isStateChangingMethod(method: string | undefined): boolean {
  const normalized = String(method ?? "").toUpperCase();
  return normalized === "POST" || normalized === "PATCH" || normalized === "DELETE";
}

export function resolveClientIp(req: http.IncomingMessage): string | null {
  const raw = req.headers["x-forwarded-for"];
  const first = Array.isArray(raw) ? raw[0] : raw;
  const candidate = String(first ?? "").split(",")[0]?.trim();
  return candidate || (req.socket.remoteAddress ? String(req.socket.remoteAddress) : null);
}

export function getUserAgent(req: http.IncomingMessage): string | null {
  const raw = req.headers["user-agent"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = String(value ?? "").trim();
  return trimmed || null;
}

export function setSecurityHeaders(res: http.ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none';");
}

export function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  setSecurityHeaders(res);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

export async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > 1_000_000) {
      throw new Error("Request body too large");
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return null;
  }
  return JSON.parse(raw) as unknown;
}

export async function readRawBody(req: http.IncomingMessage, options?: { maxBytes?: number }): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  const maxBytes = Math.max(1, options?.maxBytes ?? 25 * 1024 * 1024);
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new Error("Request body too large");
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

