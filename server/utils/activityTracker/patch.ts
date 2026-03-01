export function extractDiffPaths(patchText: string): string[] {
  const paths = new Set<string>();
  const lines = (patchText ?? "").split(/\r?\n/);
  for (const line of lines) {
    const diffMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (diffMatch) {
      const candidate = diffMatch[2];
      if (candidate && candidate !== "dev/null") {
        paths.add(candidate);
      }
      continue;
    }
    const plusMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (plusMatch) {
      const candidate = plusMatch[1];
      if (candidate && candidate !== "dev/null") {
        paths.add(candidate);
      }
      continue;
    }
  }
  return Array.from(paths);
}

