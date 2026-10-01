const EXCLUDED_PATTERNS = [
  /package-lock\.json$/,
  /pnpm-lock\.yaml$/,
  /yarn\.lock$/,
  /\.min\.(js|css)$/,
  /^dist\//,
  /^build\//,
  /\.map$/,
];

export const REVIEW_DIFF_MAX_LINES = 1500;
export const REVIEW_DIFF_MAX_CHARS = 40_000;

export function shouldExcludeFileFromDiff(filePath: string): boolean {
  return EXCLUDED_PATTERNS.some((pattern) => pattern.test(filePath));
}

export function filterDiff(rawDiff: string, maxLines = REVIEW_DIFF_MAX_LINES, diffStat?: string, maxChars = REVIEW_DIFF_MAX_CHARS): { diff: string; truncated: boolean } {
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

  const fullDiff = filteredLines.join("\n");
  if (filteredLines.length > maxLines || fullDiff.length > maxChars) {
    const header = [
      `=== DIFF SUMMARY (TRUNCATED DUE TO SIZE > ${maxLines} LINES OR ${maxChars} CHARACTERS) ===`,
      diffStat ? `Diff Stats:\n${diffStat}\n` : "",
      `Showing at most ${maxLines} lines / ${maxChars} characters out of ${filteredLines.length} lines:\n`,
    ].filter(Boolean).join("\n");
    return {
      diff: `${header}\n${filteredLines.slice(0, maxLines).join("\n").slice(0, maxChars)}\n... [TRUNCATED]`,
      truncated: true,
    };
  }

  return {
    diff: fullDiff,
    truncated: false,
  };
}

