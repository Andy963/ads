import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ISSUE_ROOT, SPEC_ROOT } from "./workItem.js";

/**
 * Workspace-relative roots the Advisor lane may write to. Anything else it
 * touches during a turn is rolled back by enforceWriteAllowlist.
 */
export function resolvePlannerWriteRoots(): string[] {
  const raw = String(process.env.ADS_PLANNER_WRITE_ROOTS ?? "").trim();
  const roots = raw
    ? raw
        .split(",")
        .map((entry) => entry.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, ""))
        .filter(Boolean)
    : [ISSUE_ROOT, SPEC_ROOT];
  return Array.from(new Set(roots));
}

export type DirtyFileState = {
  /** "tracked" entries can be restored with git; "untracked" ones only by deletion. */
  kind: "tracked" | "untracked";
  /** Content hash, or null when the path is absent (deleted) on disk. */
  hash: string | null;
};

export type WorkspaceDirtySnapshot = Map<string, DirtyFileState>;

export type WriteGuardOutcome = {
  /** Paths created or modified by this turn outside the allowlist, undone. */
  reverted: string[];
  /** Out-of-allowlist paths the user had already modified before the turn; left alone. */
  flagged: string[];
  /** Where the undone content was copied before rollback, if anything was undone. */
  quarantineDir: string | null;
  /** Set when the guard could not run at all (not a git work tree, git missing). */
  unavailableReason: string | null;
};

function runGit(cwd: string, args: string[]): { code: number | null; stdout: string } {
  try {
    const result = childProcess.spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    });
    return {
      code: typeof result.status === "number" ? result.status : null,
      stdout: String(result.stdout ?? ""),
    };
  } catch {
    return { code: null, stdout: "" };
  }
}

function hashFile(absolutePath: string): string | null {
  try {
    const buffer = fs.readFileSync(absolutePath);
    return crypto.createHash("sha256").update(buffer).digest("hex");
  } catch {
    return null;
  }
}

export function isWithinWriteRoots(relativePath: string, roots: string[]): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  return roots.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

/**
 * Lists paths git considers dirty, with a content hash for each.
 *
 * Uses `-z` so paths containing spaces or quotes survive parsing intact, and
 * `--no-renames` so a rename shows up as the delete/add pair the guard can
 * reason about individually.
 */
export function snapshotDirtyFiles(workspaceRoot: string): WorkspaceDirtySnapshot | null {
  const inside = runGit(workspaceRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    return null;
  }

  const status = runGit(workspaceRoot, ["status", "--porcelain", "-z", "--no-renames"]);
  if (status.code !== 0) {
    return null;
  }

  const snapshot: WorkspaceDirtySnapshot = new Map();
  for (const record of status.stdout.split("\0")) {
    if (record.length < 4) continue;
    const code = record.slice(0, 2);
    const relativePath = record.slice(3);
    if (!relativePath) continue;
    const kind: DirtyFileState["kind"] = code === "??" ? "untracked" : "tracked";
    snapshot.set(relativePath, { kind, hash: hashFile(path.join(workspaceRoot, relativePath)) });
  }
  return snapshot;
}

function quarantine(workspaceRoot: string, quarantineDir: string, relativePath: string): void {
  const source = path.join(workspaceRoot, relativePath);
  if (!fs.existsSync(source)) return;
  const destination = path.join(quarantineDir, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

/**
 * Undoes out-of-allowlist writes made during a planner turn.
 *
 * Only paths that this turn made dirty are touched. A file the user had already
 * modified before the turn is reported but never reverted — rolling it back
 * would destroy their uncommitted work, which is strictly worse than the
 * planner having scribbled on it. Everything undone is copied into a quarantine
 * directory first, so no content is lost outright.
 */
export function enforceWriteAllowlist(args: {
  workspaceRoot: string;
  before: WorkspaceDirtySnapshot | null;
  roots: string[];
  timestamp: number;
}): WriteGuardOutcome {
  const empty: WriteGuardOutcome = { reverted: [], flagged: [], quarantineDir: null, unavailableReason: null };

  if (args.before === null) {
    return { ...empty, unavailableReason: "workspace is not a git work tree" };
  }

  const after = snapshotDirtyFiles(args.workspaceRoot);
  if (after === null) {
    return { ...empty, unavailableReason: "failed to read workspace state after the turn" };
  }

  const reverted: string[] = [];
  const flagged: string[] = [];
  const toRevert: Array<{ relativePath: string; kind: DirtyFileState["kind"] }> = [];

  for (const [relativePath, state] of after) {
    if (isWithinWriteRoots(relativePath, args.roots)) continue;

    const previous = args.before.get(relativePath);
    if (previous && previous.hash === state.hash) {
      continue; // Already dirty before the turn and untouched by it.
    }
    if (previous) {
      flagged.push(relativePath); // Pre-existing user work; reverting would destroy it.
      continue;
    }
    toRevert.push({ relativePath, kind: state.kind });
  }

  if (toRevert.length === 0) {
    return { reverted, flagged: flagged.sort(), quarantineDir: null, unavailableReason: null };
  }

  const quarantineDir = path.join(args.workspaceRoot, ".ads", "planner-quarantine", String(args.timestamp));
  fs.mkdirSync(quarantineDir, { recursive: true });

  for (const { relativePath, kind } of toRevert) {
    try {
      quarantine(args.workspaceRoot, quarantineDir, relativePath);
      if (kind === "untracked") {
        fs.rmSync(path.join(args.workspaceRoot, relativePath), { force: true });
      } else {
        const checkout = runGit(args.workspaceRoot, ["checkout", "--", relativePath]);
        if (checkout.code !== 0) {
          flagged.push(relativePath);
          continue;
        }
      }
      reverted.push(relativePath);
    } catch {
      flagged.push(relativePath);
    }
  }

  return {
    reverted: reverted.sort(),
    flagged: flagged.sort(),
    quarantineDir: reverted.length > 0 ? quarantineDir : null,
    unavailableReason: null,
  };
}

export function formatWriteGuardMessage(outcome: WriteGuardOutcome, roots: string[]): string | null {
  if (outcome.reverted.length === 0 && outcome.flagged.length === 0) {
    return null;
  }

  const lines: string[] = [`Advisor 只能写 ${roots.map((root) => `\`${root}/\``).join("、")}。`];

  if (outcome.reverted.length > 0) {
    lines.push("", `以下越界改动已撤销（副本保留在 \`${outcome.quarantineDir}\`）：`);
    for (const file of outcome.reverted) {
      lines.push(`- ${file}`);
    }
  }

  if (outcome.flagged.length > 0) {
    lines.push("", "以下文件在本轮之前就已被修改，未自动撤销，请自行确认：");
    for (const file of outcome.flagged) {
      lines.push(`- ${file}`);
    }
  }

  return lines.join("\n");
}
