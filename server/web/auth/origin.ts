import type http from "node:http";

export function parseAllowedOrigins(raw: string | undefined): Set<string> {
  const value = String(raw ?? "").trim();
  if (!value) {
    return new Set();
  }
  const set = new Set<string>();
  for (const part of value.split(",")) {
    const origin = part.trim();
    if (!origin) continue;
    set.add(origin);
  }
  return set;
}

export function isOriginAllowed(origin: string | string[] | undefined, allowed: Set<string>): boolean {
  if (allowed.size === 0) {
    return true;
  }
  const value = Array.isArray(origin) ? origin[0] : origin;
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return false;
  }
  if (allowed.has("*")) {
    return true;
  }
  return allowed.has(trimmed);
}

function firstHeaderValue(value: string | string[] | undefined): string {
  const v = Array.isArray(value) ? value[0] : value;
  return String(v ?? "").trim();
}

function hostnameFromOrigin(origin: string): string | null {
  try {
    const host = new URL(origin).hostname.trim().toLowerCase();
    return host || null;
  } catch {
    return null;
  }
}

function hostnameFromHostHeader(host: string): string | null {
  const trimmed = host.trim();
  if (!trimmed) {
    return null;
  }
  try {
    // Host 头形如 "host[:port]"，借助 dummy scheme 复用 URL 解析（正确处理 IPv6 方括号与端口）。
    const parsed = new URL(`http://${trimmed}`).hostname.trim().toLowerCase();
    return parsed || null;
  } catch {
    return null;
  }
}

function isLoopbackHostname(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

/**
 * fail-closed 的跨站校验，用于公网（如经 frps 反代）暴露场景：
 * - 已配置 allowlist：沿用精确匹配（含通配 "*"）。
 * - 未配置 allowlist：仅在以下情况放行——
 *     1) Origin 缺失（curl/原生 WS 等非浏览器客户端；浏览器跨站请求必带 Origin）；
 *     2) Origin 主机名为 loopback；
 *     3) Origin 主机名与请求 Host 主机名一致（同源）。
 *   其余跨站一律拒绝。按 hostname 比较、忽略 scheme/port，以兼容 TLS 终止的反向代理。
 */
export function isOriginAllowedForRequest(
  req: { headers: http.IncomingHttpHeaders },
  allowed: Set<string>,
): boolean {
  const origin = firstHeaderValue(req.headers["origin"]);

  if (allowed.size > 0) {
    return isOriginAllowed(origin || undefined, allowed);
  }

  if (!origin) {
    return true;
  }
  const originHost = hostnameFromOrigin(origin);
  if (!originHost) {
    return false;
  }
  if (isLoopbackHostname(originHost)) {
    return true;
  }
  const requestHost = hostnameFromHostHeader(firstHeaderValue(req.headers["host"]));
  return requestHost !== null && originHost === requestHost;
}
