import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getExecAllowlistFromEnv, runCommand } from "../utils/commandRunner.js";

type GitTrackedChange =
  | { kind: "copy"; nextPath: string }
  | { kind: "modify"; path: string }
  | { kind: "add"; path: string }
  | { kind: "delete"; path: string }
  | { kind: "rename"; previousPath: string; nextPath: string }
  | { kind: "typechange"; path: string };

export type TaskApplyBackResult = {
  status: "applied" | "blocked" | "failed" | "skipped";
  changedPaths: string[];
  message?: string;
};

async function runGit(
  cwd: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  const res = await runCommand({
    cmd: "git",
    args,
    cwd,
    timeoutMs: 5 * 60 * 1000,
    allowlist: getExecAllowlistFromEnv(),
    maxOutputBytes: 2 * 1024 * 1024,
    signal,
  });
  if (res.exitCode !== 0) {
    throw new Error(res.stderr.trim() || res.stdout.trim() || `git exited with code ${res.exitCode}`);
  }
  return { stdout: res.stdout, stderr: res.stderr };
}

function normalizeRelativePath(workspaceRoot: string, rawPath: string): string {
  const trimmed = String(rawPath ?? "").trim();
  if (!trimmed) {
    throw new Error("path is required");
  }
  const normalized = trimmed.split("\\").join("/");
  const abs = path.resolve(workspaceRoot, normalized);
  const root = path.resolve(workspaceRoot);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`path escapes workspace root: ${trimmed}`);
  }
  return path.relative(root, abs).split(path.sep).join("/");
}

function uniquePaths(paths: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    const normalized = String(raw ?? "").trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function parseNullSeparated(text: string): string[] {
  return String(text ?? "")
    .split("\0")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function resolveBaseRef(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim();
  return raw || null;
}

async function listChangedPaths(
  worktreeDir: string,
  options?: { baseRef?: string | null; signal?: AbortSignal },
): Promise<{ tracked: GitTrackedChange[]; untracked: string[] }> {
  const baseRef = resolveBaseRef(options?.baseRef);
  const diffArgs = baseRef
    ? ["diff", "--find-renames", "--find-copies", "--name-status", "-z", baseRef]
    : ["diff", "--find-renames", "--find-copies", "--name-status", "-z", "HEAD"];
  const diffOut = await runGit(worktreeDir, diffArgs, options?.signal);
  const tokens = parseNullSeparated(diffOut.stdout);
  const tracked: GitTrackedChange[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const status = tokens[i] ?? "";
    if (!status) {
      continue;
    }
    if (status.startsWith("R")) {
      const previousPath = tokens[i + 1] ?? "";
      const nextPath = tokens[i + 2] ?? "";
      if (previousPath && nextPath) {
        tracked.push({
          kind: "rename",
          previousPath: normalizeRelativePath(worktreeDir, previousPath),
          nextPath: normalizeRelativePath(worktreeDir, nextPath),
        });
        i += 2;
      }
      continue;
    }
    if (status.startsWith("C")) {
      const sourcePath = tokens[i + 1] ?? "";
      const nextPath = tokens[i + 2] ?? "";
      if (sourcePath && nextPath) {
        void sourcePath;
        tracked.push({ kind: "copy", nextPath: normalizeRelativePath(worktreeDir, nextPath) });
        i += 2;
      }
      continue;
    }
    const filePath = tokens[i + 1] ?? "";
    if (!filePath) {
      continue;
    }
    const normalizedPath = normalizeRelativePath(worktreeDir, filePath);
    const code = status.charAt(0);
    if (code === "A") {
      tracked.push({ kind: "add", path: normalizedPath });
    } else if (code === "D") {
      tracked.push({ kind: "delete", path: normalizedPath });
    } else if (code === "T") {
      tracked.push({ kind: "typechange", path: normalizedPath });
    } else {
      tracked.push({ kind: "modify", path: normalizedPath });
    }
    i += 1;
  }

  const untrackedOut = await runGit(worktreeDir, ["ls-files", "--others", "--exclude-standard", "-z"], options?.signal);
  const untracked = parseNullSeparated(untrackedOut.stdout).map((entry) => normalizeRelativePath(worktreeDir, entry));
  return { tracked, untracked };
}

async function getHead(cwd: string, signal?: AbortSignal): Promise<string> {
  const out = await runGit(cwd, ["rev-parse", "--verify", "HEAD"], signal);
  return String(out.stdout ?? "").trim();
}

async function isWorkspaceClean(cwd: string, signal?: AbortSignal): Promise<boolean> {
  const out = await runGit(cwd, ["status", "--porcelain=v1", "--untracked-files=all"], signal);
  return !String(out.stdout ?? "").trim();
}

function removePath(targetPath: string): void {
  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function copyPath(src: string, dest: string): void {
  const srcStat = fs.lstatSync(src);
  removePath(dest);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (srcStat.isDirectory()) {
    fs.cpSync(src, dest, { recursive: true });
    return;
  }
  fs.cpSync(src, dest, { recursive: false });
}

function collectChangedPaths(changes: { tracked: GitTrackedChange[]; untracked: string[] }): string[] {
  const paths: string[] = [];
  for (const change of changes.tracked) {
    switch (change.kind) {
      case "rename":
        paths.push(change.previousPath, change.nextPath);
        break;
      case "copy":
        paths.push(change.nextPath);
        break;
      default:
        paths.push(change.path);
        break;
    }
  }
  paths.push(...changes.untracked);
  return uniquePaths(paths);
}

export async function collectWorktreeChangedPaths(
  worktreeDir: string,
  options?: { baseRef?: string | null; signal?: AbortSignal },
): Promise<string[]> {
  const changes = await listChangedPaths(worktreeDir, options);
  return collectChangedPaths(changes);
}

type WorkspaceBackupEntry = {
  relativePath: string;
  existed: boolean;
  backupPath: string | null;
};

function copyExistingPath(src: string, dest: string): void {
  const srcStat = fs.lstatSync(src);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (srcStat.isDirectory()) {
    fs.cpSync(src, dest, { recursive: true });
    return;
  }
  fs.cpSync(src, dest, { recursive: false });
}

function createWorkspaceBackup(workspaceRoot: string, changedPaths: string[]): { backupRoot: string; entries: WorkspaceBackupEntry[] } {
  const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ads-apply-back-"));
  const entries: WorkspaceBackupEntry[] = [];
  try {
    for (const relativePath of uniquePaths(changedPaths)) {
      const sourcePath = path.join(workspaceRoot, relativePath);
      if (!fs.existsSync(sourcePath)) {
        entries.push({ relativePath, existed: false, backupPath: null });
        continue;
      }
      const backupPath = path.join(backupRoot, relativePath);
      copyExistingPath(sourcePath, backupPath);
      entries.push({ relativePath, existed: true, backupPath });
    }
  } catch (error) {
    try {
      fs.rmSync(backupRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
    throw error;
  }
  return { backupRoot, entries };
}

function restoreWorkspaceBackup(workspaceRoot: string, backup: { entries: WorkspaceBackupEntry[] }): string | null {
  try {
    for (let i = backup.entries.length - 1; i >= 0; i -= 1) {
      const entry = backup.entries[i]!;
      const targetPath = path.join(workspaceRoot, entry.relativePath);
      if (!entry.existed || !entry.backupPath) {
        removePath(targetPath);
        continue;
      }
      removePath(targetPath);
      copyExistingPath(entry.backupPath, targetPath);
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export async function applyTaskRunChanges(options: {
  workspaceRoot: string;
  worktreeDir: string;
  baseHead: string;
  signal?: AbortSignal;
}): Promise<TaskApplyBackResult> {
  const workspaceRoot = path.resolve(String(options.workspaceRoot ?? "").trim());
  const worktreeDir = path.resolve(String(options.worktreeDir ?? "").trim());
  const baseHead = String(options.baseHead ?? "").trim();
  if (!workspaceRoot || !worktreeDir || !baseHead) {
    return { status: "failed", changedPaths: [], message: "workspaceRoot, worktreeDir, and baseHead are required" };
  }

  let currentHead = "";
  try {
    currentHead = await getHead(workspaceRoot, options.signal);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "blocked", changedPaths: [], message };
  }
  if (currentHead !== baseHead) {
    return { status: "blocked", changedPaths: [], message: `workspace HEAD changed: expected ${baseHead}, got ${currentHead}` };
  }

  try {
    if (!(await isWorkspaceClean(workspaceRoot, options.signal))) {
      return { status: "blocked", changedPaths: [], message: "workspace has local changes" };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "blocked", changedPaths: [], message };
  }

  let changes: Awaited<ReturnType<typeof listChangedPaths>>;
  try {
    changes = await listChangedPaths(worktreeDir, { baseRef: baseHead, signal: options.signal });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "failed", changedPaths: [], message };
  }

  const changedPaths = collectChangedPaths(changes);
  if (changedPaths.length === 0) {
    return { status: "skipped", changedPaths: [], message: "no worktree changes" };
  }

  let backup:
    | {
        backupRoot: string;
        entries: WorkspaceBackupEntry[];
      }
    | null = null;
  try {
    backup = createWorkspaceBackup(workspaceRoot, changedPaths);
    for (const change of changes.tracked) {
      switch (change.kind) {
        case "delete":
          removePath(path.join(workspaceRoot, change.path));
          break;
        case "rename":
          removePath(path.join(workspaceRoot, change.previousPath));
          copyPath(path.join(worktreeDir, change.nextPath), path.join(workspaceRoot, change.nextPath));
          break;
        case "copy":
          copyPath(path.join(worktreeDir, change.nextPath), path.join(workspaceRoot, change.nextPath));
          break;
        case "modify":
        case "add":
        case "typechange":
          copyPath(path.join(worktreeDir, change.path), path.join(workspaceRoot, change.path));
          break;
      }
    }

    for (const untrackedPath of changes.untracked) {
      copyPath(path.join(worktreeDir, untrackedPath), path.join(workspaceRoot, untrackedPath));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const rollbackMessage = backup ? restoreWorkspaceBackup(workspaceRoot, backup) : null;
    const suffix = rollbackMessage ? `; rollback failed: ${rollbackMessage}` : "";
    return { status: "failed", changedPaths, message: `${message}${suffix}` };
  } finally {
    if (backup) {
      try {
        fs.rmSync(backup.backupRoot, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }

  return { status: "applied", changedPaths };
}
