export type PreferenceDirective = {
  key: string;
  value: string;
};

const DIRECTIVE_PREFIXES = [
  "记住偏好",
  "保存偏好",
  "写入偏好",
  "更新偏好",
  "记住喜好",
  "保存喜好",
  "写入喜好",
  "更新喜好",
];

function normalizeKey(raw: string): string {
  return String(raw ?? "").trim();
}

function normalizeValue(raw: string): string {
  return String(raw ?? "").trim();
}

function parseKeyValue(raw: string): PreferenceDirective | null {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return null;

  const m = /^([^\s=:：]+)\s*(?:=|:|：)\s*(.+)$/.exec(trimmed);
  if (m) {
    const key = normalizeKey(m[1]);
    const value = normalizeValue(m[2]);
    if (!key || !value) return null;
    return { key, value };
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2) {
    const key = normalizeKey(parts[0]);
    const value = normalizeValue(parts.slice(1).join(" "));
    if (!key || !value) return null;
    return { key, value };
  }

  return null;
}

function stripPrefix(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  for (const prefix of DIRECTIVE_PREFIXES) {
    if (!trimmed.startsWith(prefix)) continue;
    return trimmed.slice(prefix.length).trim().replace(/^[:：]\s*/, "");
  }
  return null;
}

export function extractPreferenceDirectives(text: string): { directives: PreferenceDirective[]; cleanedText: string } {
  const directives: PreferenceDirective[] = [];
  const keptLines: string[] = [];

  for (const line of String(text ?? "").split("\n")) {
    const rest = stripPrefix(line);
    if (rest === null) {
      keptLines.push(line);
      continue;
    }
    const parsed = parseKeyValue(rest);
    if (!parsed) {
      keptLines.push(line);
      continue;
    }
    directives.push(parsed);
  }

  return { directives, cleanedText: keptLines.join("\n").trim() };
}

