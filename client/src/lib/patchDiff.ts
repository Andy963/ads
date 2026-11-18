export const PATCH_DIFF_FALLBACK_KEY = "__all__";

function isDevNullPath(raw: string): boolean {
  const p = String(raw ?? "").trim();
  return p === "dev/null" || p === "/dev/null";
}

export function splitUnifiedDiffByPath(raw: string): Map<string, string> {
  const diff = String(raw ?? "").trimEnd();
  const out = new Map<string, string>();
  if (!diff.trim()) return out;

  const lines = diff.split("\n");
  let currentPath: string | null = null;
  let currentStart = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (!match) continue;

    if (currentPath) {
      const section = lines.slice(currentStart, i).join("\n").trimEnd();
      if (section.trim()) out.set(currentPath, section);
    }

    const aPath = String(match[1] ?? "").trim();
    const bPath = String(match[2] ?? "").trim();
    const picked = bPath && !isDevNullPath(bPath) ? bPath : aPath;
    currentPath = picked || null;
    currentStart = i;
  }

  if (currentPath) {
    const section = lines.slice(currentStart).join("\n").trimEnd();
    if (section.trim()) out.set(currentPath, section);
  }

  if (out.size > 0) return out;
  out.set(PATCH_DIFF_FALLBACK_KEY, diff);
  return out;
}
