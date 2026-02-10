import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getExecAllowlistFromEnv, runCommand } from "../utils/commandRunner.js";
import { AsyncLock } from "../utils/asyncLock.js";
import { resolveAdsStateDir } from "../workspace/adsPaths.js";
import type { BootstrapProjectRef } from "./types.js";
import { normalizeBootstrapProjectRef } from "./projectId.js";

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

function buildRunId(nowMs: number): string {
  const d = new Date(nowMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const suffix = crypto.randomBytes(2).toString("hex");
  return `${stamp}-${suffix}`;
}

async function runGit(
  cwd: string,
  args: string[],
  options?: { allowlist?: string[] | null; signal?: AbortSignal },
): Promise<{ stdout: string; stderr: string }> {
  const allowlist = options?.allowlist ?? getExecAllowlistFromEnv();
  const res = await runCommand({
    cmd: "git",
    args,
    cwd,
    timeoutMs: 5 * 60 * 1000,
    allowlist,
    maxOutputBytes: 1024 * 1024,
    signal: options?.signal,
  });
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

type DirLockOwner = {
  pid: number;
  hostname: string;
  acquiredAtMs: number;
  projectId: string;
  runId: string;
};

function formatAbortError(): Error {
  const error = new Error("AbortError");
  error.name = "AbortError";
  return error;
}

async function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }
  if (!signal) {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
    return;
  }
  if (signal.aborted) {
    throw formatAbortError();
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(formatAbortError());
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function randomInt(min: number, max: number): number {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return Math.floor(Math.random() * 1_000);
  }
  const span = Math.floor(max - min) + 1;
  return Math.floor(Math.random() * span) + Math.floor(min);
}

function tryReadLockOwner(lockDir: string): DirLockOwner | null {
  try {
    const ownerPath = path.join(lockDir, "owner.json");
    const raw = fs.readFileSync(ownerPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<DirLockOwner>;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    if (typeof parsed.pid !== "number" || !Number.isFinite(parsed.pid)) return null;
    if (typeof parsed.hostname !== "string") return null;
    if (typeof parsed.acquiredAtMs !== "number" || !Number.isFinite(parsed.acquiredAtMs)) return null;
    if (typeof parsed.projectId !== "string") return null;
    if (typeof parsed.runId !== "string") return null;
    return {
      pid: Math.floor(parsed.pid),
      hostname: parsed.hostname,
      acquiredAtMs: Math.floor(parsed.acquiredAtMs),
      projectId: parsed.projectId,
      runId: parsed.runId,
    };
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === "ESRCH") {
      return false;
    }
    return true;
  }
}

async function acquireDirLock(
  lockDir: string,
  options: {
    timeoutMs: number;
    pollMinMs?: number;
    pollMaxMs?: number;
    owner: DirLockOwner;
    signal?: AbortSignal;
  },
): Promise<() => void> {
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs));
  const pollMinMs = Math.max(10, Math.floor(options.pollMinMs ?? 50));
  const pollMaxMs = Math.max(pollMinMs, Math.floor(options.pollMaxMs ?? 250));
  const startedAt = Date.now();
  const ownerPath = path.join(lockDir, "owner.json");

  while (true) {
    if (options.signal?.aborted) {
      throw formatAbortError();
    }

    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(ownerPath, `${JSON.stringify(options.owner)}\n`, "utf8");
      return () => {
        try {
          fs.rmSync(lockDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      };
    } catch (error) {
      const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
      if (code !== "EEXIST") {
        throw error instanceof Error ? error : new Error(String(error));
      }
    }

    const now = Date.now();
    if (now - startedAt > timeoutMs) {
      const currentOwner = tryReadLockOwner(lockDir);
      const ownerText = currentOwner
        ? `owner pid=${currentOwner.pid} host=${currentOwner.hostname} projectId=${currentOwner.projectId} runId=${currentOwner.runId}`
        : "owner unknown";
      throw new Error(`bootstrap repo lock timeout after ${timeoutMs}ms (${ownerText})`);
    }

    const currentOwner = tryReadLockOwner(lockDir);
    if (currentOwner && !isPidAlive(currentOwner.pid)) {
      try {
        fs.rmSync(lockDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
      continue;
    }

    if (!currentOwner) {
      try {
        const stat = fs.statSync(lockDir);
        if (now - stat.mtimeMs > 5_000) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // ignore
      }
    }

    await sleepMs(randomInt(pollMinMs, pollMaxMs), options.signal);
  }
}

class BootstrapProjectLockPool {
  private readonly locks = new Map<string, AsyncLock>();

  get(projectId: string): AsyncLock {
    const key = String(projectId ?? "").trim() || "default";
    const existing = this.locks.get(key);
    if (existing) {
      return existing;
    }
    const lock = new AsyncLock();
    this.locks.set(key, lock);
    return lock;
  }
}

const BOOTSTRAP_PROJECT_LOCK_POOL = new BootstrapProjectLockPool();

async function ensureRepoReady(options: {
  source: { kind: BootstrapProjectRef["kind"]; value: string };
  repoDir: string;
  runId: string;
  signal?: AbortSignal;
}): Promise<void> {
  if (!isGitRepo(options.repoDir)) {
    const parent = path.dirname(options.repoDir);
    ensureDir(parent);

    const tmpRepoDir = fs.mkdtempSync(path.join(parent, `.repo-tmp-${sanitizeSegment(options.runId, 16)}-`));

    const cloneArgs =
      options.source.kind === "git_url"
        ? ["clone", options.source.value, tmpRepoDir]
        : ["clone", "--no-hardlinks", options.source.value, tmpRepoDir];
    try {
      await runGit(process.cwd(), cloneArgs, { signal: options.signal });
    } catch (error) {
      try {
        fs.rmSync(tmpRepoDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
      throw error;
    }

    try {
      fs.rmSync(options.repoDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    fs.renameSync(tmpRepoDir, options.repoDir);
    return;
  }

  try {
    await runGit(options.repoDir, ["fetch", "--all", "--prune"], { signal: options.signal });
  } catch {
    // Best-effort: repos without remotes should still be usable for worktree creation.
  }
}

export async function prepareBootstrapWorktree(options: {
  project: BootstrapProjectRef;
  branchPrefix: string;
  stateDir?: string;
  nowMs?: number;
  signal?: AbortSignal;
}): Promise<BootstrapWorktree> {
  const nowMs = typeof options.nowMs === "number" && Number.isFinite(options.nowMs) ? Math.floor(options.nowMs) : Date.now();
  const runId = buildRunId(nowMs);

  const derivedSource = normalizeBootstrapProjectRef(options.project);
  const source = {
    kind: derivedSource.project.kind as BootstrapProjectRef["kind"],
    value: derivedSource.project.value,
    projectId: derivedSource.projectId,
    identity: derivedSource.identity,
  };

  const stateDir = path.resolve(options.stateDir ?? resolveAdsStateDir());
  const bootstrapRoot = path.join(stateDir, "bootstraps", source.projectId);
  const repoDir = path.join(bootstrapRoot, "repo");
  const worktreesDir = path.join(bootstrapRoot, "worktrees");
  const artifactsRoot = path.join(bootstrapRoot, "artifacts");
  const worktreeDir = path.join(worktreesDir, runId);
  const artifactsDir = path.join(artifactsRoot, runId);

  ensureDir(bootstrapRoot);
  ensureDir(worktreesDir);
  ensureDir(artifactsRoot);
  ensureDir(artifactsDir);

  const branchPrefix = sanitizeSegment(options.branchPrefix || "bootstrap", 32);
  const branchName = `${branchPrefix}/${runId}`;

  const projectLock = BOOTSTRAP_PROJECT_LOCK_POOL.get(source.projectId);
  await projectLock.runExclusive(async () => {
    const lockDir = path.join(bootstrapRoot, ".locks", "repo.lock");
    ensureDir(path.dirname(lockDir));
    const owner: DirLockOwner = {
      pid: process.pid,
      hostname: os.hostname(),
      acquiredAtMs: Date.now(),
      projectId: source.projectId,
      runId,
    };

    const releaseDirLock = await acquireDirLock(lockDir, {
      timeoutMs: 30 * 60 * 1000,
      pollMinMs: 50,
      pollMaxMs: 250,
      owner,
      signal: options.signal,
    });

    try {
      await ensureRepoReady({ source: { kind: source.kind, value: source.value }, repoDir, runId, signal: options.signal });

      // Best-effort cleanup for stale worktrees.
      try {
        await runGit(repoDir, ["worktree", "prune"], { signal: options.signal });
      } catch {
        // ignore
      }

      await runGit(repoDir, ["worktree", "add", "-b", branchName, worktreeDir, "HEAD"], { signal: options.signal });

      // Set a stable identity for bootstrap commits (scoped to this worktree only).
      try {
        await runGit(worktreeDir, ["config", "user.name", "ads-bootstrap"], { signal: options.signal });
        await runGit(worktreeDir, ["config", "user.email", "ads-bootstrap@local"], { signal: options.signal });
      } catch {
        // ignore
      }
    } finally {
      releaseDirLock();
    }
  });

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
