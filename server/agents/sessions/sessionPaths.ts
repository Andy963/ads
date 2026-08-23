import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Provider session files live outside the repository, so every path decision is
 * centralized here. The roots honour each provider's own environment override
 * (matching `resolveAgentSessionLocator` in the history store).
 */

export function resolveCodexHome(): string {
  const override = process.env.CODEX_HOME?.trim();
  return override || path.join(os.homedir(), ".codex");
}

export function resolveClaudeHome(): string {
  const override = process.env.CLAUDE_CONFIG_DIR?.trim();
  return override || path.join(os.homedir(), ".claude");
}

export function resolveDroidHome(): string {
  const override = process.env.FACTORY_HOME_OVERRIDE?.trim();
  return override || path.join(os.homedir(), ".factory");
}

export function codexSessionsRoot(): string {
  return path.join(resolveCodexHome(), "sessions");
}

export function claudeProjectsRoot(): string {
  return path.join(resolveClaudeHome(), "projects");
}

export function droidSessionsRoot(): string {
  return path.join(resolveDroidHome(), "sessions");
}

/**
 * Claude CLI derives a per-project directory name from the absolute cwd by
 * replacing path separators (and `.`) with dashes.
 *
 * Kept as a single function because it encodes a Claude CLI implementation
 * detail; if the layout changes only this needs updating.
 */
export function claudeProjectSlug(cwd: string): string {
  const resolved = path.resolve(String(cwd ?? "")).replace(/\/+$/, "");
  return resolved.replace(/[/.]/g, "-");
}

/**
 * Droid groups sessions by cwd below `~/.factory/sessions`, replacing path
 * separators with dashes while preserving dots and other filename characters.
 */
export function droidProjectSlug(cwd: string): string {
  const resolved = path.resolve(String(cwd ?? "")).replace(/[\\/]+$/, "");
  return resolved.replace(/[\\/]/g, "-");
}

async function listFilesRecursive(root: string, matcher: (name: string) => boolean, limit: number): Promise<string[]> {
  const found: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0 && found.length < limit) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && matcher(entry.name)) {
        found.push(full);
        if (found.length >= limit) {
          break;
        }
      }
    }
  }
  return found;
}

/**
 * Codex names rollouts `rollout-<iso-timestamp>-<threadId>.jsonl`, so a thread
 * can be located by filename without opening any file.
 */
export async function findCodexRolloutPath(threadId: string): Promise<string | null> {
  const id = String(threadId ?? "").trim();
  if (!id) {
    return null;
  }
  const matches = await listFilesRecursive(
    codexSessionsRoot(),
    (name) => name.startsWith("rollout-") && name.endsWith(`-${id}.jsonl`),
    1,
  );
  return matches[0] ?? null;
}

/**
 * Claude stores one transcript per session id under the project directory for
 * its cwd. The cwd is checked first; other project directories are only scanned
 * when the session was recorded elsewhere.
 */
export async function findClaudeTranscriptPath(sessionId: string, cwd?: string): Promise<string | null> {
  const id = String(sessionId ?? "").trim();
  if (!id) {
    return null;
  }
  if (cwd) {
    const direct = path.join(claudeProjectsRoot(), claudeProjectSlug(cwd), `${id}.jsonl`);
    try {
      await fsp.access(direct, fs.constants.R_OK);
      return direct;
    } catch {
      // Fall through to the broader scan below.
    }
  }
  const matches = await listFilesRecursive(claudeProjectsRoot(), (name) => name === `${id}.jsonl`, 1);
  return matches[0] ?? null;
}

/**
 * Droid stores `<sessionId>.jsonl` below a cwd-derived directory. Prefer the
 * expected cwd, then scan the bounded provider root for sessions moved or
 * resumed from another working directory.
 */
export async function findDroidSessionPath(sessionId: string, cwd?: string): Promise<string | null> {
  const id = String(sessionId ?? "").trim();
  if (!id) {
    return null;
  }
  if (cwd) {
    const direct = path.join(droidSessionsRoot(), droidProjectSlug(cwd), `${id}.jsonl`);
    try {
      await fsp.access(direct, fs.constants.R_OK);
      return direct;
    } catch {
      // Fall through to the broader scan below.
    }
  }
  const matches = await listFilesRecursive(droidSessionsRoot(), (name) => name === `${id}.jsonl`, 1);
  return matches[0] ?? null;
}

/**
 * Cheap existence check used in place of running a real model turn: if the
 * provider still has the session on disk, resuming it is worth attempting.
 * Unknown agents are optimistically treated as resumable.
 */
/**
 * Result of a cheap on-disk lookup.
 *
 * `unknown` matters: a missing or unreadable provider root means we cannot
 * tell whether the session exists, and callers must not treat that as a
 * permanent failure — doing so would discard a still-valid saved session id
 * because of, say, a misconfigured `CODEX_HOME`.
 */
export type SessionDiskProbe = "present" | "absent" | "unknown";

async function isReadableDir(dir: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(dir);
    if (!stat.isDirectory()) {
      return false;
    }
    await fsp.access(dir, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Cheap replacement for running a real model turn. Agents without a known
 * on-disk layout are optimistically reported as `unknown`.
 */
export async function probeSessionOnDisk(args: {
  agentId: string;
  sessionId: string;
  cwd?: string;
}): Promise<SessionDiskProbe> {
  const sessionId = String(args.sessionId ?? "").trim();
  if (!sessionId) {
    return "absent";
  }
  if (args.agentId === "codex") {
    if (!(await isReadableDir(codexSessionsRoot()))) {
      return "unknown";
    }
    return (await findCodexRolloutPath(sessionId)) ? "present" : "absent";
  }
  if (args.agentId === "claude") {
    if (!(await isReadableDir(claudeProjectsRoot()))) {
      return "unknown";
    }
    return (await findClaudeTranscriptPath(sessionId, args.cwd)) ? "present" : "absent";
  }
  if (args.agentId === "droid") {
    if (!(await isReadableDir(droidSessionsRoot()))) {
      return "unknown";
    }
    return (await findDroidSessionPath(sessionId, args.cwd)) ? "present" : "absent";
  }
  return "unknown";
}

/** List rollout/transcript files newest-first, bounded to keep scans cheap. */
export async function listRecentFiles(
  root: string,
  matcher: (name: string) => boolean,
  scanLimit: number,
): Promise<Array<{ filePath: string; mtimeMs: number }>> {
  const files = await listFilesRecursive(root, matcher, scanLimit);
  const stats = await Promise.all(
    files.map(async (filePath) => {
      try {
        const stat = await fsp.stat(filePath);
        return { filePath, mtimeMs: stat.mtimeMs };
      } catch {
        return null;
      }
    }),
  );
  return stats
    .filter((entry): entry is { filePath: string; mtimeMs: number } => entry !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}
