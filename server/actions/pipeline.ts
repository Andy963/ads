import { spawnSync } from "node:child_process";

export interface CreatePrResult {
  prNumber: number | null;
  prUrl: string | null;
  error?: string;
}

export interface MergeResult {
  success: boolean;
  error?: string;
}

export function createPullRequest(options: {
  cwd: string;
  issueId?: number | null;
  title: string;
  body?: string;
  labels?: string[];
}): CreatePrResult {
  const labels = options.labels && options.labels.length > 0 ? options.labels : ["feat"];
  const bodyText = options.body ?? (options.issueId ? `Closes #${options.issueId}` : "Automated Actions PR");

  const args = [
    "pr",
    "create",
    "--title",
    options.title,
    "--body",
    bodyText,
    ...labels.flatMap((l) => ["--label", l]),
  ];

  const res = spawnSync("gh", args, {
    cwd: options.cwd,
    encoding: "utf8",
  });

  if (res.status !== 0) {
    return {
      prNumber: null,
      prUrl: null,
      error: res.stderr?.trim() || "Failed to create PR via gh CLI",
    };
  }

  const output = res.stdout?.trim() || "";
  // gh pr create returns the PR URL (e.g. https://github.com/org/repo/pull/123)
  const match = output.match(/\/pull\/(\d+)/);
  const prNumber = match && match[1] ? Number(match[1]) : null;

  return {
    prNumber,
    prUrl: output,
  };
}

export function mergeAndCleanupPipeline(options: {
  cwd: string;
  prNumber?: number | null;
  issueId?: number | null;
  branch: string;
  baseBranch?: string;
}): MergeResult {
  const base = options.baseBranch ?? "dev";

  // 1. Merge PR if prNumber is provided
  if (options.prNumber) {
    const mergeRes = spawnSync("gh", ["pr", "merge", String(options.prNumber), "--squash", "--delete-branch=false"], {
      cwd: options.cwd,
      encoding: "utf8",
    });
    if (mergeRes.status !== 0) {
      return {
        success: false,
        error: `gh pr merge failed: ${mergeRes.stderr?.trim() || "Unknown error"}`,
      };
    }
  } else {
    // Spec §5.2: Offline / local project path without PR - fast-forward merge local feature branch to dev
    const checkoutDev = spawnSync("git", ["checkout", base], { cwd: options.cwd, encoding: "utf8" });
    if (checkoutDev.status !== 0) {
      return {
        success: false,
        error: `git checkout ${base} failed before local merge: ${checkoutDev.stderr?.trim() || "Unknown error"}`,
      };
    }

    const mergeFf = spawnSync("git", ["merge", "--ff-only", options.branch], { cwd: options.cwd, encoding: "utf8" });
    if (mergeFf.status !== 0) {
      return {
        success: false,
        error: `Local fast-forward merge of '${options.branch}' into '${base}' failed: ${mergeFf.stderr?.trim() || "Non-fast-forward"}. Branch preserved.`,
      };
    }
  }

  // 2. Close corresponding GitHub Issue
  if (options.issueId) {
    spawnSync("gh", ["issue", "close", String(options.issueId)], {
      cwd: options.cwd,
      encoding: "utf8",
    });
  }

  // 3. Checkout base branch
  const checkoutRes = spawnSync("git", ["checkout", base], {
    cwd: options.cwd,
    encoding: "utf8",
  });
  if (checkoutRes.status !== 0) {
    return {
      success: false,
      error: `git checkout ${base} failed: ${checkoutRes.stderr?.trim() || "Unknown error"}`,
    };
  }

  // 4. Fast-forward pull
  const pullRes = spawnSync("git", ["pull", "--ff-only", "origin", base], {
    cwd: options.cwd,
    encoding: "utf8",
  });
  if (pullRes.status !== 0) {
    // If pulling fails (e.g. offline / no remote), log error but continue cleanup
  }

  // 5. Delete local feature branch
  if (options.branch && options.branch !== base) {
    spawnSync("git", ["branch", "-D", options.branch], {
      cwd: options.cwd,
      encoding: "utf8",
    });

    // 6. Delete remote feature branch
    spawnSync("git", ["push", "origin", "--delete", options.branch], {
      cwd: options.cwd,
      encoding: "utf8",
    });
  }

  return { success: true };
}
