const FALLBACK_PROJECT_NAME = "Workspace";
const PLACEHOLDER_DEFAULT_NAMES = new Set(["default", "project", "workspace"]);

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

function isPlaceholderDefaultName(name: string): boolean {
  if (!name) return true;
  if (name === "\u9ed8\u8ba4") return true;
  return PLACEHOLDER_DEFAULT_NAMES.has(name.toLowerCase());
}

export function deriveProjectNameFromPath(value: string): string {
  const normalized = normalizeText(value);
  if (!normalized) return FALLBACK_PROJECT_NAME;
  const cleaned = normalized.replace(/[\\/]+$/g, "");
  const parts = cleaned.split(/[\\/]+/g).filter(Boolean);
  return parts[parts.length - 1] ?? FALLBACK_PROJECT_NAME;
}

export function resolveDefaultProjectName(args: { name?: string | null; path: string }): string {
  const rawName = normalizeText(args.name);
  const derived = deriveProjectNameFromPath(args.path);
  if (isPlaceholderDefaultName(rawName)) {
    return derived;
  }
  return rawName;
}
