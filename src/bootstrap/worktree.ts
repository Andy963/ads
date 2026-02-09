import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { getExecAllowlistFromEnv, runCommand } from "../utils/commandRunner.js";
import { resolveAdsStateDir } from "../workspace/adsPaths.js";
import type { BootstrapProjectRef } from "./types.js";
import { deriveBootstrapProjectId } from "./projectId.js";

export type BootstrapWorktree = {
  projectId: string;
  runId: string;
  bootstrapRoot: string;
  repoDir: string;
  worktreeDir: string;
  artifactsDir: string;
  branchName: string;
  source: { kind: BootstrapProjectRef["kind"]; value: string; identity: string };
};

function sanitizeSegment(value: string, maxLen = 48): string {
  const normalized = String(value ?? "").trim() || "bootstrap";
  const sanitized = normalized.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return sanitized.length > maxLen ? sanitized.slice(0, maxLen) : sanitized;
}

function slugFromGitUrl(url: string): string {
  const normalized = String(url ?? "").trim().replace(/[#?].*$/, "");
  const base = normalized.split("/").filter(Boolean).slice(-1)[0] ?? "repo";
  const withoutGit = base.toLowerCase().endsWith(".git") ? base.slice(0, -4) : base;
  return sanitizeSegment(withoutGit || base || "repo");
}

function deriveProjectIdFromGitUrl(url: string): { projectId: string; identity: string } {
  const identity = String(url ?? "").trim();
  const hash = crypto.createHash("sha256").update(identity).digest("hex").slice(0, 12);
  const slug = slugFromGitUrl(identity);
  return { projectId: `${slug}-${hash}`, identity };
}

function buildRunId(nowMs: number): string {
  const d = new Date(nowMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const suffix = crypto.randomBytes(2).toString("hex");
  return `${stamp}-${suffix}`;
}

async function runGit(cwd: string, args: string[], options?: { allowlist?: string[] | null }): Promise<{ stdout: string; stderr: string }> {
  const allowlist = options?.allowlist ?? getExecAllowlistFromEnv();
  const res = await runCommand({ cmd: "git", args, cwd, timeoutMs: 5 * 60 * 1000, allowlist, maxOutputBytes: 1024 * 1024 });
  if (res.exitCode !== 0) {
    const stderr = res.stderr.trim() || res.stdout.trim() || `git exited with code ${res.exitCode}`;
    throw new Error(stderr);
  }
  return { stdout: res.stdout, stderr: res.stderr };
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function isGitRepo(dirPath: string): boolean {
  try {
    return fs.existsSync(path.join(dirPath, ".git"));
  } catch {
    return false;
  }
}

export async function prepareBootstrapWorktree(options: {
  project: BootstrapProjectRef;
  branchPrefix: string;
  stateDir?: string;
  nowMs?: number;
}): Promise<BootstrapWorktree> {
  const nowMs = typeof options.nowMs === "number" && Number.isFinite(options.nowMs) ? Math.floor(options.nowMs) : Date.now();
  const runId = buildRunId(nowMs);

  const source = (() => {
    if (options.project.kind === "git_url") {
      const url = String(options.project.value ?? "").trim();
      if (!url) {
        throw new Error("project.value is required for git_url");
      }
      const derived = deriveProjectIdFromGitUrl(url);
      return { kind: "git_url" as const, value: url, projectId: derived.projectId, identity: derived.identity };
    }
    const rawPath = String(options.project.value ?? "").trim();
    if (!rawPath) {
      throw new Error("project.value is required for local_path");
    }
    const derived = deriveBootstrapProjectId(rawPath);
    return { kind: "local_path" as const, value: derived.resolvedPath, projectId: derived.projectId, identity: derived.identity };
  })();

  const stateDir = path.resolve(options.stateDir ?? resolveAdsStateDir());
  const bootstrapRoot = path.join(stateDir, "bootstraps", source.projectId);
  const repoDir = path.join(bootstrapRoot, "repo");
  const worktreesDir = path.join(bootstrapRoot, "worktrees");
  const artifactsRoot = path.join(bootstrapRoot, "artifacts");
  const worktreeDir = path.join(worktreesDir, runId);
  const artifactsDir = path.join(artifactsRoot, runId);

  ensureDir(repoDir);
  ensureDir(worktreesDir);
  ensureDir(artifactsRoot);
  ensureDir(artifactsDir);

  if (!isGitRepo(repoDir)) {
    try {
      fs.rmSync(repoDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    ensureDir(path.dirname(repoDir));

    const cloneArgs =
      source.kind === "git_url"
        ? ["clone", source.value, repoDir]
        : ["clone", "--no-hardlinks", source.value, repoDir];
    await runGit(process.cwd(), cloneArgs);
  } else {
    try {
      await runGit(repoDir, ["fetch", "--all", "--prune"]);
    } catch {
      // Best-effort: repos without remotes should still be usable for worktree creation.
    }
  }

  // Best-effort cleanup for stale worktrees.
  try {
    await runGit(repoDir, ["worktree", "prune"]);
  } catch {
    // ignore
  }

  const branchPrefix = sanitizeSegment(options.branchPrefix || "bootstrap", 32);
  const branchName = `${branchPrefix}/${runId}`;

  await runGit(repoDir, ["worktree", "add", "-b", branchName, worktreeDir, "HEAD"]);

  // Set a stable identity for bootstrap commits (scoped to this worktree only).
  try {
    await runGit(worktreeDir, ["config", "user.name", "ads-bootstrap"]);
    await runGit(worktreeDir, ["config", "user.email", "ads-bootstrap@local"]);
  } catch {
    // ignore
  }

  return {
    projectId: source.projectId,
    runId,
    bootstrapRoot,
    repoDir,
    worktreeDir,
    artifactsDir,
    branchName,
    source: { kind: source.kind, value: source.value, identity: source.identity },
  };
}

