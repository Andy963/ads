function normalizeWhitespace(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

export function truncateForLog(text: string, limit = 96): string {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 1)}…`;
}

export function normalizeOutput(text: string): string {
  if (typeof text !== "string") {
    return "(无输出)";
  }
  return text.trim() ? text : "(无输出)";
}

