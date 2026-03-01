import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type PatchFileStat = {
  path: string;
  added: number | null;
  removed: number | null;
};

export type WorkspacePatchPayload = {
  files: PatchFileStat[];
  diff: string;
  truncated: boolean;
};

export type BuildWorkspacePatchOptions = {
  maxFiles: number;
  maxBytes: number;
};

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function parseEnvInt(name: string, fallback: number): number {
  const raw = String(process.env[name] ?? "").trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function runGit(
  cwd: string,
  args: string[],
): { code: number | null; stdout: string; stderr: string; error?: Error } {
  try {
    const result = childProcess.spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 20 * 1024 * 1024,
    });
    return {
      code: typeof result.status === "number" ? result.status : null,
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? ""),
      error: result.error instanceof Error ? result.error : undefined,
    };
  } catch (error) {
    return {
      code: null,
      stdout: "",
      stderr: "",
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

function isGitWorkTree(cwd: string): boolean {
  const out = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return out.code === 0 && out.stdout.trim() === "true";
}

function hasHeadCommit(cwd: string): boolean {
  const out = runGit(cwd, ["rev-parse", "--verify", "HEAD"]);
  return out.code === 0;
}

function dedupePaths(paths: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    const trimmed = String(raw ?? "").trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function normalizePathSpec(workspaceRoot: string, rawPath: string): string | null {
  const trimmed = String(rawPath ?? "").trim();
  if (!trimmed) return null;

  const resolved = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(workspaceRoot, trimmed);
  const normalizedRoot = path.resolve(workspaceRoot);

  // Do not report diffs for paths outside the workspace root.
  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + path.sep)) {
    return null;
  }

  const rel = path.relative(workspaceRoot, resolved);
  // Git pathspecs should use forward slashes.
  return rel.split(path.sep).join("/");
}

function parseNumstat(output: string): Map<string, { added: number | null; removed: number | null }> {
  const map = new Map<string, { added: number | null; removed: number | null }>();
  const lines = String(output ?? "").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const rawAdded = parts[0] ?? "";
    const rawRemoved = parts[1] ?? "";
    const filePath = parts.slice(2).join("\t").trim();
    if (!filePath) continue;

    const added = rawAdded === "-" ? null : Number.parseInt(rawAdded, 10);
    const removed = rawRemoved === "-" ? null : Number.parseInt(rawRemoved, 10);
    map.set(filePath, {
      added: Number.isFinite(added as number) ? (added as number) : null,
      removed: Number.isFinite(removed as number) ? (removed as number) : null,
    });
  }
  return map;
}

function mergeNumstat(
  a: Map<string, { added: number | null; removed: number | null }>,
  b: Map<string, { added: number | null; removed: number | null }>,
): Map<string, { added: number | null; removed: number | null }> {
  const out = new Map<string, { added: number | null; removed: number | null }>();
  for (const [k, v] of a.entries()) out.set(k, { ...v });
  for (const [k, v] of b.entries()) {
    const prev = out.get(k);
    if (!prev) {
      out.set(k, { ...v });
      continue;
    }
    if (prev.added === null || prev.removed === null || v.added === null || v.removed === null) {
      out.set(k, { added: null, removed: null });
      continue;
    }
    out.set(k, { added: prev.added + v.added, removed: prev.removed + v.removed });
  }
  return out;
}

function resolveUntrackedPaths(workspaceRoot: string, pathspecs: string[]): Set<string> {
  const out = runGit(workspaceRoot, ["ls-files", "--others", "--exclude-standard", "--", ...pathspecs]);
  if (out.code !== 0) return new Set();
  const raw = out.stdout.trim();
  if (!raw) return new Set();
  const entries = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return new Set(entries);
}

function countFileLines(p: string): number {
  try {
    const raw = fs.readFileSync(p, "utf8");
    if (!raw) return 0;
    // Count newline-separated lines; avoid allocating a huge array for large files.
    let lines = 1;
    for (let i = 0; i < raw.length; i++) {
      if (raw.charCodeAt(i) === 10) lines++;
    }
    return lines;
  } catch {
    return 0;
  }
}

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const raw = String(text ?? "");
  const max = clampInt(maxBytes, 8 * 1024, 2 * 1024 * 1024);
  const buf = Buffer.from(raw, "utf8");
  if (buf.byteLength <= max) {
    return { text: raw, truncated: false };
  }
  const slice = buf.subarray(0, max);
  const truncatedText = slice.toString("utf8");
  return { text: truncatedText, truncated: true };
}

export function buildWorkspacePatch(
  workspaceRoot: string,
  rawPaths: string[],
  opts?: Partial<BuildWorkspacePatchOptions>,
): WorkspacePatchPayload | null {
  const maxFiles = clampInt(
    opts?.maxFiles ?? parseEnvInt("ADS_WEB_PATCH_MAX_FILES", 20),
    1,
    200,
  );
  const maxBytes = clampInt(
    opts?.maxBytes ?? parseEnvInt("ADS_WEB_PATCH_MAX_BYTES", 200_000),
    8 * 1024,
    2 * 1024 * 1024,
  );

  if (!isGitWorkTree(workspaceRoot)) {
    return null;
  }

  const normalizedRoot = path.resolve(workspaceRoot);
  const pathspecs = dedupePaths(rawPaths)
    .map((p) => normalizePathSpec(normalizedRoot, p))
    .filter((p): p is string => Boolean(p))
    .slice(0, maxFiles);

  if (pathspecs.length === 0) return null;

  const untracked = resolveUntrackedPaths(normalizedRoot, pathspecs);
  const tracked = pathspecs.filter((p) => !untracked.has(p));

  const diffParts: string[] = [];
  let numstat = new Map<string, { added: number | null; removed: number | null }>();

  const headOk = hasHeadCommit(normalizedRoot);
  if (tracked.length > 0) {
    if (headOk) {
      const diffOut = runGit(normalizedRoot, ["diff", "--patch", "--no-color", "HEAD", "--", ...tracked]);
      if (diffOut.stdout.trim()) diffParts.push(diffOut.stdout.trimEnd());
      const statOut = runGit(normalizedRoot, ["diff", "--numstat", "HEAD", "--", ...tracked]);
      numstat = mergeNumstat(numstat, parseNumstat(statOut.stdout));
    } else {
      const diffWorking = runGit(normalizedRoot, ["diff", "--patch", "--no-color", "--", ...tracked]);
      if (diffWorking.stdout.trim()) diffParts.push(diffWorking.stdout.trimEnd());
      const diffCached = runGit(normalizedRoot, ["diff", "--cached", "--patch", "--no-color", "--", ...tracked]);
      if (diffCached.stdout.trim()) diffParts.push(diffCached.stdout.trimEnd());

      const statWorking = runGit(normalizedRoot, ["diff", "--numstat", "--", ...tracked]);
      const statCached = runGit(normalizedRoot, ["diff", "--cached", "--numstat", "--", ...tracked]);
      numstat = mergeNumstat(numstat, mergeNumstat(parseNumstat(statWorking.stdout), parseNumstat(statCached.stdout)));
    }
  }

  for (const untrackedPath of untracked.values()) {
    const diffOut = runGit(normalizedRoot, [
      "diff",
      "--no-index",
      "--patch",
      "--no-color",
      "--",
      "/dev/null",
      untrackedPath,
    ]);
    if (diffOut.stdout.trim()) diffParts.push(diffOut.stdout.trimEnd());

    const statOut = runGit(normalizedRoot, ["diff", "--no-index", "--numstat", "--", "/dev/null", untrackedPath]);
    numstat = mergeNumstat(numstat, parseNumstat(statOut.stdout));
  }

  const combined = diffParts.filter(Boolean).join("\n\n");
  if (!combined.trim()) {
    return null;
  }

  const files: PatchFileStat[] = pathspecs.map((p) => {
    const stat = numstat.get(p);
    if (stat) {
      return { path: p, added: stat.added, removed: stat.removed };
    }
    if (untracked.has(p)) {
      const abs = path.join(normalizedRoot, p);
      const added = countFileLines(abs);
      return { path: p, added, removed: 0 };
    }
    return { path: p, added: null, removed: null };
  });

  const truncated = truncateUtf8(combined, maxBytes);
  const suffix = truncated.truncated ? "\n\n... Diff truncated: max bytes reached ...\n" : "";
  const diff = truncated.text.trimEnd() + suffix;

  return { files, diff, truncated: truncated.truncated };
}
