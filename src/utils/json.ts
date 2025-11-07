export function safeParseJson<T>(payload: string | null | undefined): T | null {
  if (!payload) {
    return null;
  }

  try {
    return JSON.parse(payload) as T;
  } catch {
    return null;
  }
}

export function safeStringify(value: unknown, indent = 2): string {
  return JSON.stringify(value, (_key, val) => {
    if (val instanceof Map) {
      return Object.fromEntries(val.entries());
    }
    if (val instanceof Set) {
      return Array.from(val.values());
    }
    return val;
  }, indent);
}
