import { spawnSync } from "node:child_process";
import type { Database as DatabaseType } from "better-sqlite3";
import { type ActionJobRecord } from "../state/actionJobStore.js";

export interface GateCheckResult {
  allowed: boolean;
  gateBlocked?: "terminal" | "cleanliness" | "sync";
  reason?: string;
}

export function checkThreePointGate(
  db: DatabaseType,
  repoPath: string,
  projectId: string,
  targetBranch = "dev",
): GateCheckResult {
  // 1. Terminal State Gate
  const activeJobs = db.prepare(
    "SELECT * FROM action_jobs WHERE project_id = ? AND status IN ('running', 'verifying', 'reviewing', 'waiting_merge') LIMIT 1"
  ).get(projectId) as ActionJobRecord | undefined;

  if (activeJobs) {
    return {
      allowed: false,
      gateBlocked: "terminal",
      reason: `Active job ${activeJobs.id} is currently in non-terminal status: ${activeJobs.status}`,
    };
  }

  // 2. Working Tree Cleanliness Gate
  const branchRes = spawnSync("git", ["branch", "--show-current"], {
    cwd: repoPath,
    encoding: "utf8",
  });
  const currentBranch = branchRes.stdout?.trim();
  if (currentBranch !== targetBranch) {
    return {
      allowed: false,
      gateBlocked: "cleanliness",
      reason: `Current branch is '${currentBranch}', expected '${targetBranch}'`,
    };
  }

  const statusRes = spawnSync("git", ["status", "--porcelain", "-uno"], {
    cwd: repoPath,
    encoding: "utf8",
  });
  const trackedDirty = statusRes.stdout?.trim();
  if (trackedDirty) {
    return {
      allowed: false,
      gateBlocked: "cleanliness",
      reason: `Working tree has uncommitted tracked changes: ${trackedDirty.slice(0, 100)}`,
    };
  }

  // 3. Base Branch Synchronization Gate
  const fetchRes = spawnSync("git", ["fetch", "origin", targetBranch], {
    cwd: repoPath,
    encoding: "utf8",
  });

  // If remote origin exists, check head alignment
  if (fetchRes.status === 0) {
    const headRes = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repoPath,
      encoding: "utf8",
    });
    const remoteRes = spawnSync("git", ["rev-parse", `origin/${targetBranch}`], {
      cwd: repoPath,
      encoding: "utf8",
    });

    const localHead = headRes.stdout?.trim();
    const remoteHead = remoteRes.stdout?.trim();

    if (localHead && remoteHead && localHead !== remoteHead) {
      const baseRes = spawnSync("git", ["merge-base", localHead, remoteHead], {
        cwd: repoPath,
        encoding: "utf8",
      });
      const mergeBase = baseRes.stdout?.trim();
      if (mergeBase !== remoteHead) {
        return {
          allowed: false,
          gateBlocked: "sync",
          reason: `Local '${targetBranch}' (HEAD: ${localHead.slice(0, 7)}) is not synchronized with remote origin/${targetBranch} (${remoteHead.slice(0, 7)})`,
        };
      }
    }
  }

  return { allowed: true };
}
