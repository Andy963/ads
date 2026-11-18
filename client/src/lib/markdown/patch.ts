function basenameLike(path: string): string {
  const raw = String(path ?? "").trim();
  if (!raw) return "";
  const parts = raw.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : raw;
}

export function extractPatchFilePaths(text: string): string[] {
  const raw = String(text ?? "");
  if (!raw) return [];

  const out: string[] = [];
  const seen = new Set<string>();
  const lines = raw.split("\n");

  for (const lineRaw of lines) {
    const line = lineRaw.trim();
    if (!line) continue;

    let path: string | null = null;

    const diffGit = /^diff --git a\/(.+?) b\/(.+?)$/.exec(line);
    if (diffGit) {
      path = diffGit[2] ?? diffGit[1] ?? null;
    }

    if (!path) {
      const plus = /^\+\+\+\s+(?:b\/)?(.+)$/.exec(line);
      if (plus) {
        const candidate = String(plus[1] ?? "").trim();
        if (candidate && candidate !== "/dev/null") path = candidate;
      }
    }
    if (!path) {
      const minus = /^---\s+(?:a\/)?(.+)$/.exec(line);
      if (minus) {
        const candidate = String(minus[1] ?? "").trim();
        if (candidate && candidate !== "/dev/null") path = candidate;
      }
    }

    if (!path) {
      const match =
        /^\*\*\*\s+(?:Update|Add|Delete)\s+File:\s+(.+)$/.exec(line) ??
        /^\*\*\*\s+Move to:\s+(.+)$/.exec(line);
      if (match) path = match[1] ?? null;
    }

    if (!path) continue;

    const normalized = String(path).trim().replace(/^["']/, "").replace(/["']$/, "");
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }

  return out;
}

export function isPatchLike(text: string): boolean {
  const raw = String(text ?? "");
  if (!raw) return false;
  if (raw.includes("*** Begin Patch")) return true;
  if (/^diff --git /m.test(raw)) return true;
  if (/^\+\+\+ /m.test(raw) && /^--- /m.test(raw)) return true;
  return false;
}

export function formatCollapsedFileList(
  paths: string[],
  maxItems: number,
): { summary: string; hiddenCount: number } {
  const basenames = paths.map((path) => basenameLike(path)).filter(Boolean);
  const shown = basenames.slice(0, Math.max(0, maxItems));
  const hiddenCount = Math.max(0, basenames.length - shown.length);
  const summary = shown.join(", ");
  return { summary, hiddenCount };
}
