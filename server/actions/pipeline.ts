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

// `gh pr create` without --base targets the repository default branch, which is
// main in this repo. Creation and delivery must read the same value, so both
// sides resolve the base from this constant.
export const ACTIONS_BASE_BRANCH = "dev";

export function buildPrCreateArgs(options: {
  title: string;
  body: string;
  labels: string[];
  baseBranch: string;
  headBranch?: string;
}): string[] {
  return [
    "pr",
    "create",
    "--base",
    options.baseBranch,
    // Without --head gh reads the checked-out branch, so a workspace switched by
    // another session would open the pull request against the wrong branch.
    ...(options.headBranch ? ["--head", options.headBranch] : []),
    "--title",
    options.title,
    "--body",
    options.body,
    ...options.labels.flatMap((label) => ["--label", label]),
  ];
}

export function branchScopeError(params: {
  baseBranch: string;
  branch: string;
  expectedBaseSha: string;
  mergeBaseSha: string;
}): string | null {
  if (params.expectedBaseSha === params.mergeBaseSha) return null;
  return (
    `Feature branch '${params.branch}' does not descend from the '${params.baseBranch}' commit ` +
    `recorded when the job started (${params.expectedBaseSha}); its merge-base is ` +
    `${params.mergeBaseSha}. It carries commits unrelated to this job.`
  );
}

// gh pr merge reads no confirmation flag; without a TTY it merges immediately.
// Passing an unknown flag makes gh exit non-zero before any merge is attempted.
const GH_PR_MERGE_SUPPORTED_FLAGS = new Set([
  "--admin",
  "--author-email",
  "--auto",
  "--body",
  "--body-file",
  "--delete-branch",
  "--disable-auto",
  "--match-head-commit",
  "--merge",
  "--rebase",
  "--squash",
  "--subject",
]);

export function buildPrMergeArgs(prNumber: number): string[] {
  return ["pr", "merge", String(prNumber), "--squash"];
}

export function unsupportedPrMergeFlags(args: string[]): string[] {
  return args.filter((arg) => arg.startsWith("--") && !GH_PR_MERGE_SUPPORTED_FLAGS.has(arg));
}

interface PullRequestMergeState {
  state?: string;
  mergedAt?: string | null;
  mergeCommit?: { oid?: string | null } | null;
}

export function checkFeatureBranchScope(
  cwd: string,
  baseBranch: string,
  branch: string,
  expectedBaseSha?: string | null,
): string | null {
  const baseSha = spawnSync("git", ["rev-parse", baseBranch], { cwd, encoding: "utf8" });
  if (baseSha.status !== 0) {
    return `Base branch '${baseBranch}' could not be resolved in '${cwd}'.`;
  }

  // The recorded anchor, not the current base tip, decides the verdict: the base
  // branch advancing after the branch was created is normal and must not reject
  // a clean feature branch. Jobs predating the anchor column carry no value, and
  // a wrong rejection would strand them, so they skip the check.
  if (!expectedBaseSha) return null;

  const anchor = spawnSync("git", ["cat-file", "-e", `${expectedBaseSha}^{commit}`], { cwd, encoding: "utf8" });
  if (anchor.status !== 0) return null;

  const mergeBase = spawnSync("git", ["merge-base", expectedBaseSha, branch], { cwd, encoding: "utf8" });
  if (mergeBase.status !== 0) {
    return `No common ancestor between '${baseBranch}' at ${expectedBaseSha} and '${branch}'. The branch carries unrelated history.`;
  }

  return branchScopeError({
    baseBranch,
    branch,
    expectedBaseSha,
    mergeBaseSha: mergeBase.stdout?.trim() ?? "",
  });
}

export interface ExistingPullRequest {
  prNumber: number;
  prUrl: string;
}

export function parseOpenPullRequest(raw: string): ExistingPullRequest | null {
  let parsed: Array<{ number?: unknown; url?: unknown }>;
  try {
    parsed = JSON.parse(raw || "[]") as typeof parsed;
  } catch {
    return null;
  }
  const first = Array.isArray(parsed) ? parsed[0] : undefined;
  const prNumber = Number(first?.number);
  const prUrl = typeof first?.url === "string" ? first.url : "";
  return Number.isInteger(prNumber) && prNumber > 0 && prUrl ? { prNumber, prUrl } : null;
}

export function findOpenPullRequest(cwd: string, branch: string): ExistingPullRequest | null {
  const res = spawnSync(
    "gh",
    ["pr", "list", "--head", branch, "--state", "open", "--limit", "1", "--json", "number,url"],
    { cwd, encoding: "utf8" },
  );
  if (res.status !== 0) return null;
  return parseOpenPullRequest(res.stdout?.trim() || "");
}

export function createPullRequest(options: {
  cwd: string;
  issueId?: number | null;
  title: string;
  body?: string;
  labels?: string[];
  baseBranch?: string;
  branch?: string;
  baseSha?: string | null;
}): CreatePrResult {
  const baseBranch = options.baseBranch ?? ACTIONS_BASE_BRANCH;
  const labels = options.labels && options.labels.length > 0 ? options.labels : ["feat"];
  const bodyText = options.body ?? (options.issueId ? `Closes #${options.issueId}` : "Automated Actions PR");

  if (options.branch) {
    // A rework pass reaches this point with the branch already carrying a pull
    // request. Reusing it keeps the job on the same PR instead of failing on
    // "a pull request for this branch already exists".
    const existing = findOpenPullRequest(options.cwd, options.branch);
    if (existing) {
      return { prNumber: existing.prNumber, prUrl: existing.prUrl };
    }

    const scopeError = checkFeatureBranchScope(options.cwd, baseBranch, options.branch, options.baseSha);
    if (scopeError) {
      return { prNumber: null, prUrl: null, error: scopeError };
    }
  }

  const args = buildPrCreateArgs({
    title: options.title,
    body: bodyText,
    labels,
    baseBranch,
    headBranch: options.branch,
  });

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
  const base = options.baseBranch ?? ACTIONS_BASE_BRANCH;
  const hasRemote = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd: options.cwd,
    encoding: "utf8",
  }).status === 0;
  let mergeCommit: string | null = null;

  // 1. Merge PR if prNumber is provided
  if (options.prNumber) {
    const mergeRes = spawnSync("gh", buildPrMergeArgs(options.prNumber), {
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

export interface PullRequestStateResult {
  state: string | null;
  merged: boolean;
  baseRefName: string | null;
  mergedAt: number | null;
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
}): PullRequestStateResult {
  const unknown: PullRequestStateResult = { state: null, merged: false, baseRefName: null, mergedAt: null };
  const res = spawnSync(
    "gh",
    ["pr", "view", String(options.prNumber), "--json", "state,mergedAt,baseRefName"],
    { cwd: options.cwd, encoding: "utf8" },
  );
  if (res.status !== 0) {
    return { ...unknown, error: res.stderr?.trim() || "Failed to read pull request state" };
  }

  let parsed: { state?: unknown; mergedAt?: unknown; baseRefName?: unknown };
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
    mergedAt: mergedAt ? Date.parse(mergedAt) || null : null,
  };
}
