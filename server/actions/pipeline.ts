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

export function buildPrMergeArgs(prNumber: number, expectedHead?: string): string[] {
  return ["pr", "merge", String(prNumber), "--squash", ...(expectedHead ? ["--match-head-commit", expectedHead] : [])];
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

export function pushFeatureBranch(cwd: string, branch: string): string | null {
  const res = spawnSync("git", ["push", "origin", branch], {
    cwd,
    encoding: "utf8",
  });
  if (res.status === 0) return null;
  return `git push origin ${branch} failed: ${res.stderr?.trim() || "Unknown error"}`;
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
    const scopeError = checkFeatureBranchScope(options.cwd, baseBranch, options.branch, options.baseSha);
    if (scopeError) {
      return { prNumber: null, prUrl: null, error: scopeError };
    }

    // The Developer is required to commit, but the Actions controller owns PR
    // delivery. Publish the branch before asking GitHub to resolve its head;
    // otherwise a valid local implementation is reported as an empty PR.
    const pushError = pushFeatureBranch(options.cwd, options.branch);
    if (pushError) return { prNumber: null, prUrl: null, error: pushError };

    // A rework pass reaches this point with the branch already carrying a pull
    // request. Reusing it keeps the job on the same PR instead of failing on
    // "a pull request for this branch already exists".
    const existing = findOpenPullRequest(options.cwd, options.branch);
    if (existing) {
      return { prNumber: existing.prNumber, prUrl: existing.prUrl };
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
  expectedHead?: string;
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
    const prior = options.expectedHead ? readPullRequestState({ cwd: options.cwd, prNumber: options.prNumber, includeHead: true }) : null;
    if (prior && (prior.error || prior.headRefOid !== options.expectedHead || prior.baseRefName !== base)) {
      return { success: false, error: "Pull request does not match the reviewed head and base." };
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
    ["pr", "view", String(options.prNumber), "--json", options.includeHead ? "state,mergedAt,baseRefName,headRefOid" : "state,mergedAt,baseRefName"],
    { cwd: options.cwd, encoding: "utf8" },
  );
  if (res.status !== 0) {
    return { ...unknown, error: res.stderr?.trim() || "Failed to read pull request state" };
  }

  let parsed: { state?: unknown; mergedAt?: unknown; baseRefName?: unknown; headRefOid?: unknown };
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
    ...(options.includeHead ? { headRefOid: typeof parsed.headRefOid === "string" ? parsed.headRefOid : null } : {}),
  };
}
