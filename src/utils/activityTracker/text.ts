function safeJsonParse(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeFirstLine(text: string): string {
  return (text ?? "").trim().split(/\r?\n/)[0]?.trim() ?? "";
}

function truncate(text: string, maxLen: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxLen - 1))}…`;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function displayPath(value: string): string {
  const unquoted = unquote(value);
  const trimmed = unquoted.replace(/[\\/]+$/g, "");
  if (!trimmed) {
    return unquoted;
  }
  if (trimmed === "." || trimmed === "..") {
    return trimmed;
  }
  const parts = trimmed.split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0) {
    return trimmed;
  }
  const keep = Math.min(2, parts.length);
  return parts.slice(parts.length - keep).join("/");
}

export { displayPath, normalizeFirstLine, safeJsonParse, truncate };

