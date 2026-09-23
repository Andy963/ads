const EXCLUDED_PATTERNS = [
  /package-lock\.json$/,
  /pnpm-lock\.yaml$/,
  /yarn\.lock$/,
  /\.min\.(js|css)$/,
  /^dist\//,
  /^build\//,
  /\.map$/,
];

export function shouldExcludeFileFromDiff(filePath: string): boolean {
  return EXCLUDED_PATTERNS.some((pattern) => pattern.test(filePath));
}

export function filterDiff(rawDiff: string, maxLines = 800, diffStat?: string): { diff: string; truncated: boolean } {
  const lines = rawDiff.split("\n");
  const filteredLines: string[] = [];
  let skippingCurrentFile = false;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const match = line.match(/^diff --git a\/(.+?) b\/(.+?)$/);
      if (match && match[1]) {
        skippingCurrentFile = shouldExcludeFileFromDiff(match[1]);
      } else {
        skippingCurrentFile = false;
      }
    }
    if (!skippingCurrentFile) {
      filteredLines.push(line);
    }
  }

  if (filteredLines.length > maxLines) {
    const header = [
      "=== DIFF SUMMARY (TRUNCATED DUE TO SIZE > 800 LINES) ===",
      diffStat ? `Diff Stats:\n${diffStat}\n` : "",
      `Showing first ${maxLines} lines out of ${filteredLines.length}:\n`,
    ].filter(Boolean).join("\n");
    return {
      diff: `${header}\n${filteredLines.slice(0, maxLines).join("\n")}\n... [TRUNCATED]`,
      truncated: true,
    };
  }

  return {
    diff: filteredLines.join("\n"),
    truncated: false,
  };
}

