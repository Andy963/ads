import { spawnSync } from "node:child_process";

import { extractRelatedContexts } from "../reviewer/contextExtractor.js";
import { filterDiff, REVIEW_DIFF_MAX_LINES } from "../reviewer/diffFilter.js";
import type { ReviewPayload } from "../reviewer/types.js";

export type ReviewIssueSnapshot = {
  id?: number | null;
  title: string;
  description: string;
  acceptanceCriteria: string[];
};

export type ReviewTarget = {
  issue: ReviewIssueSnapshot;
  adrs?: Array<{ id: string; title: string; decision: string }>;
  baseRef: string;
  headRef: string;
  baseCommit?: string | null;
  headCommit?: string | null;
};

export type ReviewCaptureOptions = {
  requirePinnedEvidence?: boolean;
  testReport?: ReviewPayload["testReport"];
  diffOverride?: {
    diff: string;
    diffStat: string;
    range?: string;
  };
};

export type ReviewGitResult = {
  status: number;
  stdout: string;
  stderr: string;
};

export function validateGitEvidence(input: {
  diff: string;
  diffStat: string;
  baseCommit?: string;
  headCommit?: string;
}): string | undefined {
  const errors: string[] = [];
  if (!input.diff.trim()) errors.push("git diff returned empty output");
  if (!input.diffStat.trim()) errors.push("git diff --stat returned empty output");
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(input.baseCommit ?? "")) {
    errors.push(`git rev-parse base returned an invalid commit: ${input.baseCommit ?? "<empty>"}`);
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(input.headCommit ?? "")) {
    errors.push(`git rev-parse review head returned an invalid commit: ${input.headCommit ?? "<empty>"}`);
  }
  return errors.length > 0 ? errors.join("; ") : undefined;
}

function isCommitHash(value: string | null | undefined): value is string {
  return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
}

export function captureReviewPayload(
  target: ReviewTarget,
  repoPath: string,
  options: ReviewCaptureOptions = {},
): ReviewPayload {
  const requirePinnedEvidence = options.requirePinnedEvidence === true;
  const git = (args: string[]) => spawnSync("git", args, { cwd: repoPath, encoding: "utf8" });
  const captureErrors: string[] = [];
  const configuredBase = requirePinnedEvidence ? target.baseCommit : target.baseRef;
  const configuredHead = requirePinnedEvidence ? target.headCommit : target.headRef;

  if (requirePinnedEvidence && !configuredBase) captureErrors.push("review target does not have a recorded base commit");
  if (requirePinnedEvidence && !configuredHead) captureErrors.push("review target does not have a pinned head commit");
  if (requirePinnedEvidence && configuredBase && !isCommitHash(configuredBase)) {
    captureErrors.push("review target has an invalid recorded base commit");
  }
  if (requirePinnedEvidence && configuredHead && !isCommitHash(configuredHead)) {
    captureErrors.push("review target has an invalid pinned head commit");
  }

  const baseRef = configuredBase || "<missing-base>";
  const headRef = configuredHead || "<missing-head>";
  const baseCommitResult = !requirePinnedEvidence || isCommitHash(configuredBase)
    ? git(["rev-parse", "--verify", `${baseRef}^{commit}`])
    : null;
  const headCommitResult = !requirePinnedEvidence || isCommitHash(configuredHead)
    ? git(["rev-parse", "--verify", `${headRef}^{commit}`])
    : null;
  const baseCommit = baseCommitResult?.stdout?.trim();
  const headCommit = headCommitResult?.stdout?.trim();
  const separator = requirePinnedEvidence ? ".." : "...";
  const capturedRange = `${baseCommit || baseRef}${separator}${headCommit || headRef}`;

  if (requirePinnedEvidence && baseCommit && headCommit) {
    const ancestryResult = git(["merge-base", "--is-ancestor", baseCommit, headCommit]);
    if (ancestryResult.status !== 0) {
      captureErrors.push("recorded base commit is not an ancestor of the pinned head");
    }
  }
  const diffRes = options.diffOverride
    ? { status: 0, stdout: options.diffOverride.diff }
    : baseCommit && headCommit ? git(["diff", capturedRange]) : null;
  const diffStatRes = options.diffOverride
    ? { status: 0, stdout: options.diffOverride.diffStat }
    : baseCommit && headCommit ? git(["diff", "--stat", capturedRange]) : null;

  if (!baseCommitResult || baseCommitResult.status !== 0) captureErrors.push(`git rev-parse base '${baseRef}' failed`);
  if (!headCommitResult || headCommitResult.status !== 0) captureErrors.push("git rev-parse review head failed");
  if (!diffRes || diffRes.status !== 0) captureErrors.push(`git diff exited with status ${String(diffRes?.status ?? "unavailable")}`);
  if (!diffStatRes || diffStatRes.status !== 0) captureErrors.push(`git diff --stat exited with status ${String(diffStatRes?.status ?? "unavailable")}`);

  const diff = diffRes?.stdout || "";
  const diffStat = diffStatRes?.stdout || "";
  const evidenceError = validateGitEvidence({ diff, diffStat, baseCommit, headCommit });
  const diffCaptureError = [...captureErrors, evidenceError]
    .filter((error): error is string => Boolean(error))
    .join("; ");

  return {
    issue: target.issue,
    adrs: target.adrs,
    diffRange: {
      baseRef,
      headRef,
      baseCommit: baseCommit || undefined,
      headCommit: headCommit || undefined,
      range: options.diffOverride?.range
        ?? (requirePinnedEvidence ? capturedRange : `${baseRef}...${headRef}`),
    },
    diff,
    diffStat,
    diffCaptureError: diffCaptureError || undefined,
    testReport: options.testReport,
    ...(!diffCaptureError && baseCommit && headCommit
      && !filterDiff(diff, REVIEW_DIFF_MAX_LINES, diffStat).truncated
      ? extractRelatedContexts(repoPath, baseCommit, headCommit)
      : {}),
  };
}

export async function captureReviewPayloadAsync(
  target: ReviewTarget,
  repoPath: string,
  options: ReviewCaptureOptions = {},
  git: (args: string[]) => Promise<ReviewGitResult>,
): Promise<ReviewPayload> {
  const requirePinnedEvidence = options.requirePinnedEvidence === true;
  const captureErrors: string[] = [];
  const configuredBase = requirePinnedEvidence ? target.baseCommit : target.baseRef;
  const configuredHead = requirePinnedEvidence ? target.headCommit : target.headRef;

  if (requirePinnedEvidence && !configuredBase) captureErrors.push("review target does not have a recorded base commit");
  if (requirePinnedEvidence && !configuredHead) captureErrors.push("review target does not have a pinned head commit");
  if (requirePinnedEvidence && configuredBase && !isCommitHash(configuredBase)) {
    captureErrors.push("review target has an invalid recorded base commit");
  }
  if (requirePinnedEvidence && configuredHead && !isCommitHash(configuredHead)) {
    captureErrors.push("review target has an invalid pinned head commit");
  }

  const baseRef = configuredBase || "<missing-base>";
  const headRef = configuredHead || "<missing-head>";
  const baseCommitResult = !requirePinnedEvidence || isCommitHash(configuredBase)
    ? await git(["rev-parse", "--verify", `${baseRef}^{commit}`])
    : null;
  const headCommitResult = !requirePinnedEvidence || isCommitHash(configuredHead)
    ? await git(["rev-parse", "--verify", `${headRef}^{commit}`])
    : null;
  const baseCommit = baseCommitResult?.stdout.trim();
  const headCommit = headCommitResult?.stdout.trim();
  const separator = requirePinnedEvidence ? ".." : "...";
  const capturedRange = `${baseCommit || baseRef}${separator}${headCommit || headRef}`;

  if (requirePinnedEvidence && baseCommit && headCommit) {
    const ancestryResult = await git(["merge-base", "--is-ancestor", baseCommit, headCommit]);
    if (ancestryResult.status !== 0) captureErrors.push("recorded base commit is not an ancestor of the pinned head");
  }
  const diffRes = options.diffOverride
    ? { status: 0, stdout: options.diffOverride.diff }
    : baseCommit && headCommit ? await git(["diff", capturedRange]) : null;
  const diffStatRes = options.diffOverride
    ? { status: 0, stdout: options.diffOverride.diffStat }
    : baseCommit && headCommit ? await git(["diff", "--stat", capturedRange]) : null;

  if (!baseCommitResult || baseCommitResult.status !== 0) captureErrors.push(`git rev-parse base '${baseRef}' failed`);
  if (!headCommitResult || headCommitResult.status !== 0) captureErrors.push("git rev-parse review head failed");
  if (!diffRes || diffRes.status !== 0) captureErrors.push(`git diff exited with status ${String(diffRes?.status ?? "unavailable")}`);
  if (!diffStatRes || diffStatRes.status !== 0) captureErrors.push(`git diff --stat exited with status ${String(diffStatRes?.status ?? "unavailable")}`);

  const diff = diffRes?.stdout || "";
  const diffStat = diffStatRes?.stdout || "";
  const evidenceError = validateGitEvidence({ diff, diffStat, baseCommit, headCommit });
  const diffCaptureError = [...captureErrors, evidenceError]
    .filter((error): error is string => Boolean(error))
    .join("; ");

  return {
    issue: target.issue,
    adrs: target.adrs,
    diffRange: {
      baseRef,
      headRef,
      baseCommit: baseCommit || undefined,
      headCommit: headCommit || undefined,
      range: options.diffOverride?.range
        ?? (requirePinnedEvidence ? capturedRange : `${baseRef}...${headRef}`),
    },
    diff,
    diffStat,
    diffCaptureError: diffCaptureError || undefined,
    testReport: options.testReport,
    ...(!diffCaptureError && baseCommit && headCommit
      && !filterDiff(diff, REVIEW_DIFF_MAX_LINES, diffStat).truncated
      ? extractRelatedContexts(repoPath, baseCommit, headCommit)
      : {}),
  };
}
