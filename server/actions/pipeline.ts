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

interface PullRequestMergeState {
  state?: string;
  mergedAt?: string | null;
  mergeCommit?: { oid?: string | null } | null;
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
  const hasRemote = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd: options.cwd,
    encoding: "utf8",
  }).status === 0;
  let mergeCommit: string | null = null;

  // 1. Merge PR if prNumber is provided
  if (options.prNumber) {
    const mergeRes = spawnSync("gh", ["pr", "merge", String(options.prNumber), "--squash", "--delete-branch=false", "--yes"], {
      cwd: options.cwd,
      encoding: "utf8",
    });
    if (mergeRes.status !== 0) {
      return {
        success: false,
        error: `gh pr merge failed: ${mergeRes.stderr?.trim() || "Unknown error"}`,
      };
    }

    const stateRes = spawnSync("gh", ["pr", "view", String(options.prNumber), "--json", "state,mergedAt,mergeCommit"], {
      cwd: options.cwd,
      encoding: "utf8",
    });
    if (stateRes.status !== 0) {
      return {
        success: false,
        error: `gh pr state verification failed: ${stateRes.stderr?.trim() || "Unknown error"}`,
      };
    }

    let state: PullRequestMergeState;
    try {
      state = JSON.parse(stateRes.stdout || "{}") as PullRequestMergeState;
    } catch (error) {
      return {
        success: false,
        error: `gh pr state verification returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    mergeCommit = state.mergeCommit?.oid ?? null;
    if (state.state !== "MERGED" || !state.mergedAt || !mergeCommit) {
      return {
        success: false,
        error: `Pull request #${options.prNumber} did not reach MERGED state`,
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

    const ancestorRes = spawnSync("git", ["merge-base", "--is-ancestor", options.branch, "HEAD"], {
      cwd: options.cwd,
      encoding: "utf8",
    });
    if (ancestorRes.status !== 0) {
      return {
        success: false,
        error: `Local merge verification failed: '${options.branch}' is not an ancestor of '${base}'.`,
      };
    }
  }

  // 2. Close corresponding GitHub Issue
  if (hasRemote && options.issueId) {
    const issueCloseRes = spawnSync("gh", ["issue", "close", String(options.issueId)], {
      cwd: options.cwd,
      encoding: "utf8",
    });
    if (issueCloseRes.status !== 0) {
      return {
        success: false,
        error: `gh issue close failed: ${issueCloseRes.stderr?.trim() || "Unknown error"}`,
      };
    }
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
  if (hasRemote && pullRes.status !== 0) {
    return {
      success: false,
      error: `git pull --ff-only origin ${base} failed: ${pullRes.stderr?.trim() || "Unknown error"}`,
    };
  }

  if (mergeCommit) {
    const containsMergeRes = spawnSync("git", ["merge-base", "--is-ancestor", mergeCommit, "HEAD"], {
      cwd: options.cwd,
      encoding: "utf8",
    });
    if (containsMergeRes.status !== 0) {
      return {
        success: false,
        error: `Merge commit ${mergeCommit} is not present on '${base}' after synchronization.`,
      };
    }
  }

  // 5. Delete local feature branch
  if (options.branch && options.branch !== base) {
    const branchExists = spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${options.branch}`], {
      cwd: options.cwd,
      encoding: "utf8",
    });
    if (branchExists.status === 0) {
      const deleteLocalRes = spawnSync("git", ["branch", "-D", options.branch], {
        cwd: options.cwd,
        encoding: "utf8",
      });
      if (deleteLocalRes.status !== 0) {
        return {
          success: false,
          error: `git branch -D ${options.branch} failed: ${deleteLocalRes.stderr?.trim() || "Unknown error"}`,
        };
      }
    }

    // 6. Delete remote feature branch
    if (hasRemote) {
      const remoteBranch = spawnSync("git", ["ls-remote", "--exit-code", "--heads", "origin", options.branch], {
        cwd: options.cwd,
        encoding: "utf8",
      });
      if (remoteBranch.status === 0) {
        const deleteRemoteRes = spawnSync("git", ["push", "origin", "--delete", options.branch], {
          cwd: options.cwd,
          encoding: "utf8",
        });
        if (deleteRemoteRes.status !== 0) {
          return {
            success: false,
            error: `git push origin --delete ${options.branch} failed: ${deleteRemoteRes.stderr?.trim() || "Unknown error"}`,
          };
        }
      }
    }
  }

  return { success: true };
}
