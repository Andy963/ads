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

