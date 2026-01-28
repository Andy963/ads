export function parseCookies(header: string | string[] | undefined): Record<string, string> {
  const raw = Array.isArray(header) ? header.join(";") : String(header ?? "");
  const out: Record<string, string> = {};
  if (!raw) return out;
  const parts = raw.split(";");
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const k = trimmed.slice(0, idx).trim();
    const v = trimmed.slice(idx + 1).trim();
    if (!k) continue;
    out[k] = v;
  }
  return out;
}

export type CookieOptions = {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
  path?: string;
  maxAgeSeconds?: number;
};

export function serializeCookie(name: string, value: string, options?: CookieOptions): string {
  const parts: string[] = [];
  parts.push(`${name}=${value}`);
  const path = options?.path ?? "/";
  parts.push(`Path=${path}`);
  if (typeof options?.maxAgeSeconds === "number") {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`);
  }
  if (options?.httpOnly !== false) {
    parts.push("HttpOnly");
  }
  if (options?.secure !== false) {
    parts.push("Secure");
  }
  if (options?.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }
  return parts.join("; ");
}

