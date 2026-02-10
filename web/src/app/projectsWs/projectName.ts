export function deriveProjectNameFromPath(value: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "Workspace";
  const cleaned = normalized.replace(/[\\/]+$/g, "");
  const parts = cleaned.split(/[\\/]+/g).filter(Boolean);
  return parts[parts.length - 1] ?? "Workspace";
}

export function resolveDefaultProjectName(args: { name?: string | null; path: string }): string {
  const rawName = String(args.name ?? "").trim();
  const derived = deriveProjectNameFromPath(args.path);
  if (!rawName) return derived;
  const lowered = rawName.toLowerCase();
  if (rawName === "\u9ed8\u8ba4" || lowered === "default" || lowered === "project" || lowered === "workspace") {
    return derived;
  }
  return rawName;
}
