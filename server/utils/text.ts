function normalizeWhitespace(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

export function parseCsv(value: string | undefined): string[] {
  return String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function truncateForLog(text: string, limit = 96): string {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 1)}…`;
}
