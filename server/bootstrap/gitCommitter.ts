import fs from "node:fs";
import path from "node:path";

import type { CommandRunRequest, CommandRunResult } from "../utils/commandRunner.js";

const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_BINARY_SNIFF_BYTES = 8192;

const DEFAULT_FORBIDDEN_DIRS = new Set([
  "node_modules",
  ".venv",
  "dist",
  "build",
  "coverage",
  "__pycache__",
]);

function normalizeRepoPath(filePath: string): string {
  return String(filePath ?? "").trim().replace(/\\/g, "/");
}

function isForbiddenPath(filePath: string, forbiddenDirs: ReadonlySet<string>): boolean {
  const normalized = normalizeRepoPath(filePath);
  if (!normalized) return true;
  const parts = normalized.split("/").filter(Boolean);
  return parts.some((p) => forbiddenDirs.has(p));
}

function isProbablyBinary(filePath: string, sniffBytes: number): boolean {
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(Math.max(1, sniffBytes));
      const read = fs.readSync(fd, buf, 0, buf.length, 0);
      for (let i = 0; i < read; i += 1) {
        if (buf[i] === 0) {
          return true;
        }
      }
      return false;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

async function runGit(
  cwd: string,
  args: string[],
  deps: { runCommand: (req: CommandRunRequest) => Promise<CommandRunResult> },
): Promise<CommandRunResult> {
  return await deps.runCommand({ cmd: "git", args, cwd, timeoutMs: 2 * 60 * 1000 });
}

function parsePorcelainV1Z(output: string): string[] {
  const entries = output.split("\u0000").filter((e) => e.length > 0);
  const paths: string[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i] ?? "";
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const payload = entry.slice(3);
    const isRenameOrCopy = status.includes("R") || status.includes("C");
    if (isRenameOrCopy) {
      const newPath = entries[i + 1] ?? "";
      if (newPath) {
        paths.push(newPath);
      }
      i += 1;
      continue;
    }
    if (payload) {
      paths.push(payload);
    }
  }
  return paths;
}

export async function stageSafeBootstrapChanges(
  worktreeDir: string,
  deps: { runCommand: (req: CommandRunRequest) => Promise<CommandRunResult> },
  options?: { maxFileBytes?: number; forbiddenDirs?: ReadonlySet<string> },
): Promise<{ staged: string[]; skipped: Array<{ path: string; reason: string }> }> {
  const forbiddenDirs = options?.forbiddenDirs ?? DEFAULT_FORBIDDEN_DIRS;
  const maxFileBytes = typeof options?.maxFileBytes === "number" && options.maxFileBytes > 0 ? Math.floor(options.maxFileBytes) : DEFAULT_MAX_FILE_BYTES;

  const statusRes = await runGit(worktreeDir, ["status", "--porcelain=v1", "-z"], deps);
  if (statusRes.exitCode !== 0) {
    throw new Error(statusRes.stderr.trim() || statusRes.stdout.trim() || `git status exited with code ${statusRes.exitCode}`);
  }

  const candidates = parsePorcelainV1Z(statusRes.stdout);
  const staged: string[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  const toStage: string[] = [];

  for (const rel of candidates) {
    const normalized = normalizeRepoPath(rel);
    if (!normalized) continue;
    if (isForbiddenPath(normalized, forbiddenDirs)) {
      skipped.push({ path: normalized, reason: "forbidden_path" });
      continue;
    }

    const abs = path.resolve(worktreeDir, normalized);
    const relToRoot = path.relative(worktreeDir, abs);
    if (relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) {
      skipped.push({ path: normalized, reason: "path_escape" });
      continue;
    }

    if (!fs.existsSync(abs)) {
      toStage.push(normalized);
      continue;
    }

    const stat = fs.lstatSync(abs);
    if (stat.isSymbolicLink()) {
      skipped.push({ path: normalized, reason: "symlink" });
      continue;
    }
    if (!stat.isFile()) {
      skipped.push({ path: normalized, reason: "not_a_file" });
      continue;
    }
    if (stat.size > maxFileBytes) {
      skipped.push({ path: normalized, reason: `too_large:${stat.size}` });
      continue;
    }
    if (isProbablyBinary(abs, DEFAULT_BINARY_SNIFF_BYTES)) {
      skipped.push({ path: normalized, reason: "binary_file" });
      continue;
    }

    toStage.push(normalized);
  }

  for (const group of chunk(toStage, 50)) {
    const addRes = await runGit(worktreeDir, ["add", "-A", "--", ...group], deps);
    if (addRes.exitCode !== 0) {
      throw new Error(addRes.stderr.trim() || addRes.stdout.trim() || `git add exited with code ${addRes.exitCode}`);
    }
    staged.push(...group);
  }

  return { staged, skipped };
}

function formatCommitMessage(template: string, goal: string): string {
  const shortGoal = String(goal ?? "").trim().replace(/\s+/g, " ").slice(0, 72);
  const msg = template.replace(/\$\{goal\}/g, shortGoal || "bootstrap");
  return msg.trim() || `bootstrap: ${shortGoal || "bootstrap"}`;
}

export async function commitBootstrapChanges(
  worktreeDir: string,
  deps: { runCommand: (req: CommandRunRequest) => Promise<CommandRunResult> },
  options: { goal: string; messageTemplate: string },
): Promise<{ commit: string | null }> {
  const message = formatCommitMessage(options.messageTemplate, options.goal);

  const diffRes = await runGit(worktreeDir, ["diff", "--cached", "--name-only", "-z"], deps);
  if (diffRes.exitCode !== 0) {
    throw new Error(diffRes.stderr.trim() || diffRes.stdout.trim() || `git diff exited with code ${diffRes.exitCode}`);
  }
  if (!diffRes.stdout) {
    return { commit: null };
  }

  const commitRes = await runGit(worktreeDir, ["commit", "-m", message], deps);
  if (commitRes.exitCode !== 0) {
    throw new Error(commitRes.stderr.trim() || commitRes.stdout.trim() || `git commit exited with code ${commitRes.exitCode}`);
  }

  const headRes = await runGit(worktreeDir, ["rev-parse", "HEAD"], deps);
  if (headRes.exitCode !== 0) {
    throw new Error(headRes.stderr.trim() || headRes.stdout.trim() || `git rev-parse exited with code ${headRes.exitCode}`);
  }
  const commit = headRes.stdout.trim();
  return { commit: commit || null };
}

