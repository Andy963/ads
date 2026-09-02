import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type TaskWorktree = {
  workspaceRoot: string;
  worktreeDir: string;
  branchName: string;
  baseHead: string;
};

export type TaskWorktreeCleanup = {
  status: "cleaned" | "failed";
  error: string | null;
  cleanedAt: number;
};

type GitResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

function runGit(cwd: string, args: string[]): GitResult {
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

function gitFailure(result: GitResult, command: string): Error {
  const detail = [result.error?.message, result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("; ");
  return new Error(`${command} failed${detail ? `: ${detail}` : ""}`);
}

function requireGitValue(workspaceRoot: string, args: string[], label: string): string {
  const result = runGit(workspaceRoot, args);
  const value = result.stdout.trim();
  if (result.code !== 0 || !value) {
    throw gitFailure(result, `git ${args.join(" ")} (${label})`);
  }
  return value;
}

function slug(value: string): string {
  const normalized = String(value ?? "").trim().replace(/[^a-zA-Z0-9._-]+/g, "-");
  return normalized.slice(0, 48) || "task";
}

function parseStatusPaths(output: string): string[] {
  const paths: string[] = [];
  for (const line of String(output ?? "").split("\n")) {
    if (!line || line.length < 4) continue;
    const relative = line.slice(3).trim();
    if (!relative) continue;
    const renamed = relative.split(" -> ");
    for (const candidate of renamed) {
      const normalized = candidate.trim();
      if (normalized) paths.push(normalized);
    }
  }
  return paths;
}

function appendUnique(target: Set<string>, values: string[]): void {
  for (const value of values) {
    const normalized = String(value ?? "").trim();
    if (normalized) target.add(normalized);
  }
}

export class TaskWorktreeManager {
  private readonly workspaceRoot: string;
  private readonly worktreeParent: string;

  constructor(options: { workspaceRoot: string; worktreeParent?: string }) {
    const rawWorkspaceRoot = String(options.workspaceRoot ?? "").trim();
    if (!rawWorkspaceRoot) {
      throw new Error("A concrete workspace root is required for task worktrees");
    }
    this.workspaceRoot = path.resolve(rawWorkspaceRoot);
    const workspaceDigest = crypto.createHash("sha1").update(this.workspaceRoot).digest("hex").slice(0, 16);
    this.worktreeParent = path.resolve(
      options.worktreeParent ?? path.join(os.tmpdir(), "ads-task-worktrees", workspaceDigest),
    );
  }

  prepare(taskId: string, taskRunId: string): TaskWorktree {
    const normalizedTaskId = String(taskId ?? "").trim();
    const normalizedRunId = String(taskRunId ?? "").trim();
    if (!normalizedTaskId || !normalizedRunId) {
      throw new Error("taskId and taskRunId are required to create a worktree");
    }

    const isWorkTree = requireGitValue(this.workspaceRoot, ["rev-parse", "--is-inside-work-tree"], "worktree");
    if (isWorkTree !== "true") {
      throw new Error(`Workspace is not a Git worktree: ${this.workspaceRoot}`);
    }
    const baseHead = requireGitValue(this.workspaceRoot, ["rev-parse", "--verify", "HEAD"], "HEAD");
    fs.mkdirSync(this.worktreeParent, { recursive: true });

    const branchName = `ads/task/${slug(normalizedTaskId)}-${slug(normalizedRunId.slice(0, 16))}`;
    const worktreeDir = path.join(
      this.worktreeParent,
      `${slug(normalizedTaskId)}-${slug(normalizedRunId.slice(0, 16))}-${crypto.randomBytes(4).toString("hex")}`,
    );
    if (fs.existsSync(worktreeDir)) {
      throw new Error(`Refusing to reuse an existing task worktree: ${worktreeDir}`);
    }

    const added = runGit(this.workspaceRoot, ["worktree", "add", "--no-track", "-b", branchName, worktreeDir, baseHead]);
    if (added.code !== 0) {
      throw gitFailure(added, "git worktree add");
    }

    const status = runGit(worktreeDir, ["status", "--porcelain"]);
    if (status.code !== 0 || status.stdout.trim()) {
      const detail = status.stdout.trim() || status.stderr.trim() || "worktree is not clean";
      this.cleanup({ workspaceRoot: this.workspaceRoot, worktreeDir, branchName, baseHead });
      throw new Error(`Created task worktree is not clean: ${detail}`);
    }

    return { workspaceRoot: this.workspaceRoot, worktreeDir, branchName, baseHead };
  }

  collectChangedPaths(worktree: TaskWorktree): string[] {
    const changed = new Set<string>();
    const status = runGit(worktree.worktreeDir, ["status", "--porcelain", "--untracked-files=all"]);
    if (status.code === 0) appendUnique(changed, parseStatusPaths(status.stdout));

    const tracked = runGit(worktree.worktreeDir, ["diff", "--name-only", worktree.baseHead]);
    if (tracked.code === 0) appendUnique(changed, tracked.stdout.split("\n"));

    const staged = runGit(worktree.worktreeDir, ["diff", "--cached", "--name-only"]);
    if (staged.code === 0) appendUnique(changed, staged.stdout.split("\n"));
    return Array.from(changed);
  }

  readHead(worktree: TaskWorktree): string | null {
    const result = runGit(worktree.worktreeDir, ["rev-parse", "--verify", "HEAD"]);
    return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : null;
  }

  cleanup(worktree: TaskWorktree): TaskWorktreeCleanup {
    const cleanedAt = Date.now();
    const resolvedDir = path.resolve(worktree.worktreeDir);
    const parentPrefix = `${this.worktreeParent}${path.sep}`;
    if (!resolvedDir.startsWith(parentPrefix)) {
      return {
        status: "failed",
        error: `Refusing to clean a worktree outside the managed directory: ${resolvedDir}`,
        cleanedAt,
      };
    }

    const errors: string[] = [];
    if (fs.existsSync(resolvedDir)) {
      const removed = runGit(this.workspaceRoot, ["worktree", "remove", "--force", resolvedDir]);
      if (removed.code !== 0 && fs.existsSync(resolvedDir)) {
        errors.push(gitFailure(removed, "git worktree remove").message);
      }
    }
    if (fs.existsSync(resolvedDir)) {
      try {
        fs.rmSync(resolvedDir, { recursive: true, force: true });
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (fs.existsSync(resolvedDir)) {
      errors.push(`worktree directory still exists: ${resolvedDir}`);
    }
    return {
      status: errors.length > 0 ? "failed" : "cleaned",
      error: errors.length > 0 ? errors.join("; ") : null,
      cleanedAt,
    };
  }
}
