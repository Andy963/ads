import { spawnSync } from "node:child_process";

export interface MergeResult {
  success: boolean;
  error?: string;
}

// Acopilot creates the pull request against this base and delivery merges the
// reviewed pull request into it, so both sides read the same value here.
export const ACTIONS_BASE_BRANCH = "dev";

export function buildPrMergeArgs(prNumber: number, expectedHead?: string): string[] {
  return ["pr", "merge", String(prNumber), "--squash", ...(expectedHead ? ["--match-head-commit", expectedHead] : [])];
}

interface PullRequestMergeState {
  state?: string;
  mergedAt?: string | null;
  mergeCommit?: { oid?: string | null } | null;
}

export function mergeAndCleanupPipeline(options: {
  cwd: string;
  prNumber?: number | null;
  issueId?: number | null;
  branch: string;
  baseBranch?: string;
  expectedHead?: string;
  expectedBaseSha?: string;
}): MergeResult {
  const base = options.baseBranch ?? ACTIONS_BASE_BRANCH;
  // A reviewed PR may be merged while somebody advances its branch. Cleanup
  // must never discard those newer, unreviewed commits.
  if (options.expectedHead && options.branch && options.branch !== base) {
    const ref = spawnSync("git", ["rev-parse", "--verify", `refs/heads/${options.branch}`], { cwd: options.cwd, encoding: "utf8" });
    if (ref.status === 0 && ref.stdout.trim() !== options.expectedHead) {
      return { success: false, error: "Feature branch advanced beyond the reviewed commit; preserve it instead of cleaning up." };
    }
  }
  const hasRemote = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd: options.cwd,
    encoding: "utf8",
  }).status === 0;
  let mergeCommit: string | null = null;

  // 1. Merge PR if prNumber is provided
  if (options.prNumber) {
    const prior = options.expectedHead || options.expectedBaseSha
      ? readPullRequestState({ cwd: options.cwd, prNumber: options.prNumber, includeHead: true })
      : null;
    if (prior && (prior.error
      || (options.expectedHead && prior.headRefOid !== options.expectedHead)
      || prior.baseRefName !== base
      || (options.expectedBaseSha && prior.baseRefOid !== options.expectedBaseSha))) {
      return { success: false, error: "Pull request does not match the reviewed head, base, or base commit." };
    }
    const mergeRes = prior?.merged ? { status: 0, stderr: "" } : spawnSync("gh", buildPrMergeArgs(options.prNumber, options.expectedHead), {
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
    if (options.expectedHead) {
      const error = deleteReviewedFeatureBranch(options.cwd, options.branch, options.expectedHead, hasRemote);
      return error ? { success: false, error } : { success: true };
    }
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

export function deleteReviewedFeatureBranch(cwd: string, branch: string, expectedHead: string, hasRemote: boolean): string | null {
  const ref = `refs/heads/${branch}`;
  const local = spawnSync("git", ["rev-parse", "--verify", ref], { cwd, encoding: "utf8" });
  const remote = hasRemote ? spawnSync("git", ["ls-remote", "--exit-code", "--heads", "origin", ref], { cwd, encoding: "utf8" }) : null;
  if ((local.status === 0 && local.stdout.trim() !== expectedHead)
    || (remote?.status === 0 && remote.stdout.split(/\s+/)[0] !== expectedHead)) {
    return "Feature branch advanced beyond the reviewed commit; branch refs were preserved.";
  }
  if (remote && remote.status !== 0 && remote.status !== 2) return "Unable to verify remote branch before cleanup.";
  if (local.status === 0) {
    // Compare-and-delete prevents a concurrent writer from losing new commits.
    const deleted = spawnSync("git", ["update-ref", "-d", ref, expectedHead], { cwd, encoding: "utf8" });
    if (deleted.status !== 0) return "Local branch changed during cleanup; it was preserved.";
  }
  if (remote?.status === 0) {
    const deleted = spawnSync("git", ["push", "origin", `:${ref}`, `--force-with-lease=${ref}:${expectedHead}`], { cwd, encoding: "utf8" });
    if (deleted.status !== 0) return `Remote branch cleanup refused: ${deleted.stderr.trim()}`;
  }
  return null;
}

export interface PullRequestStateResult {
  state: string | null;
  merged: boolean;
  baseRefName: string | null;
  baseRefOid?: string | null;
  mergedAt: number | null;
  headRefOid?: string | null;
  error?: string;
}

/**
 * Reads the real state of a pull request from GitHub. This is a read-only
 * probe: it never merges, so the caller decides what a merged pull request
 * means for the job.
 */
export function readPullRequestState(options: {
  cwd: string;
  prNumber: number;
  includeHead?: boolean;
}): PullRequestStateResult {
  const unknown: PullRequestStateResult = { state: null, merged: false, baseRefName: null, mergedAt: null };
  const res = spawnSync(
    "gh",
    ["pr", "view", String(options.prNumber), "--json", options.includeHead
      ? "state,mergedAt,baseRefName,baseRefOid,headRefOid"
      : "state,mergedAt,baseRefName,baseRefOid"],
    { cwd: options.cwd, encoding: "utf8" },
  );
  if (res.status !== 0) {
    return { ...unknown, error: res.stderr?.trim() || "Failed to read pull request state" };
  }

  let parsed: { state?: unknown; mergedAt?: unknown; baseRefName?: unknown; baseRefOid?: unknown; headRefOid?: unknown };
  try {
    parsed = JSON.parse(res.stdout || "{}") as typeof parsed;
  } catch (error) {
    return { ...unknown, error: `Unparseable pull request state: ${String(error)}` };
  }

  const mergedAt = typeof parsed.mergedAt === "string" ? parsed.mergedAt : "";
  return {
    ...unknown,
    state: typeof parsed.state === "string" ? parsed.state : null,
    merged: mergedAt.length > 0,
    baseRefName: typeof parsed.baseRefName === "string" ? parsed.baseRefName : null,
    baseRefOid: typeof parsed.baseRefOid === "string" ? parsed.baseRefOid : null,
    mergedAt: mergedAt ? Date.parse(mergedAt) || null : null,
    ...(options.includeHead ? { headRefOid: typeof parsed.headRefOid === "string" ? parsed.headRefOid : null } : {}),
  };
}
