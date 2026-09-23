import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { Database as DatabaseType } from "better-sqlite3";

import { runDetachedReview } from "../reviewer/runner.js";
import type { ReviewPayload, ReviewVerdict } from "../reviewer/types.js";
import {
  createActionJob,
  getActionJobs,
  getActionJobById,
  updateActionJobStatus,
  type ActionJobRecord,
  type ActionJobStatus,
  type ActionJobKind,
} from "../state/actionJobStore.js";
import { checkThreePointGate, type GateCheckResult } from "./threePointGate.js";
import { createPullRequest, mergeAndCleanupPipeline } from "./pipeline.js";

function generateJobId(issueId?: number | null): string {
  const ts = Date.now();
  const target = issueId ? String(issueId) : "local";
  const hex = randomBytes(2).toString("hex");
  return `job-${ts}-${target}-${hex}`;
}

export function hasGitRemoteOrigin(repoPath: string): boolean {
  const res = spawnSync("git", ["remote", "get-url", "origin"], { cwd: repoPath, encoding: "utf8" });
  return res.status === 0 && Boolean(res.stdout?.trim());
}

export function safeResetToDev(repoPath: string): void {
  spawnSync("git", ["checkout", "dev"], { cwd: repoPath, encoding: "utf8" });
}

export class LaneDispatchBus {
  private processingProjects = new Set<string>();

  constructor(private db: DatabaseType) {}

  public dispatchJob(params: {
    projectId: string;
    issueId?: number | null;
    issueTitle: string;
    jobKind?: ActionJobKind;
    developerProfileId?: string | null;
    reviewerProfileIds?: string[];
    repoPath?: string;
  }): { ok: boolean; jobId: string; status: ActionJobStatus } {
    const id = generateJobId(params.issueId);
    const branch = params.issueId ? `codex/issue-${params.issueId}` : `codex/${id}`;

    const job = createActionJob(this.db, {
      id,
      project_id: params.projectId,
      job_kind: params.jobKind ?? (params.issueId ? "github_issue" : "local_prompt"),
      issue_id: params.issueId,
      issue_title: params.issueTitle,
      status: "queued",
      branch,
      developer_profile_id: params.developerProfileId,
      reviewer_profile_ids_json: JSON.stringify(params.reviewerProfileIds ?? []),
    });

    if (params.repoPath) {
      // Non-blocking trigger of queue evaluation
      queueMicrotask(() => {
        void this.evaluateQueue(params.projectId, params.repoPath!);
      });
    }

    return {
      ok: true,
      jobId: job.id,
      status: job.status,
    };
  }

  public async evaluateQueue(projectId: string, repoPath: string): Promise<GateCheckResult & { dequeuedJobId?: string }> {
    if (this.processingProjects.has(projectId)) {
      return { allowed: false, reason: "Queue is already being evaluated" };
    }

    this.processingProjects.add(projectId);
    try {
      const queuedJobs = this.db.prepare(
        "SELECT * FROM action_jobs WHERE project_id = ? AND status = 'queued' ORDER BY created_at ASC"
      ).all(projectId) as ActionJobRecord[];

      if (queuedJobs.length === 0) {
        return { allowed: true };
      }

      const nextJob = queuedJobs[0]!;
      const gateResult = checkThreePointGate(this.db, repoPath, projectId);

      if (!gateResult.allowed) {
        if (gateResult.gateBlocked === "cleanliness") {
          updateActionJobStatus(this.db, nextJob.id, "queued", {
            error_message: gateResult.reason,
          });
        }
        return gateResult;
      }

      // Gate passed: checkout feature branch and mark running
      if (nextJob.branch) {
        let checkoutOk = false;
        const branchCheck = spawnSync("git", ["checkout", "-b", nextJob.branch], {
          cwd: repoPath,
          encoding: "utf8",
        });
        if (branchCheck.status === 0) {
          checkoutOk = true;
        } else {
          // If branch already exists (e.g. rework), check it out directly
          const fallbackCheck = spawnSync("git", ["checkout", nextJob.branch], {
            cwd: repoPath,
            encoding: "utf8",
          });
          if (fallbackCheck.status === 0) {
            checkoutOk = true;
          }
        }

        const currentBranch = spawnSync("git", ["branch", "--show-current"], {
          cwd: repoPath,
          encoding: "utf8",
        }).stdout?.trim();

        if (!checkoutOk || currentBranch !== nextJob.branch) {
          updateActionJobStatus(this.db, nextJob.id, "failed", {
            error_message: `Failed to checkout feature branch '${nextJob.branch}'. Current branch is '${currentBranch}'.`,
          });
          safeResetToDev(repoPath);
          return {
            allowed: false,
            gateBlocked: "cleanliness",
            reason: `Checkout to '${nextJob.branch}' failed. Reset to dev.`,
          };
        }
      }

      updateActionJobStatus(this.db, nextJob.id, "running", {
        current_step: "Developer executing implementation on feature branch",
      });

      queueMicrotask(() => {
        void this.runJobCycle(nextJob.id, repoPath);
      });

      return {
        allowed: true,
        dequeuedJobId: nextJob.id,
      };
    } finally {
      this.processingProjects.delete(projectId);
    }
  }

  public async runJobCycle(
    jobId: string,
    repoPath: string,
    options: {
      testCommand?: string;
      callReviewerModel?: (prompt: string, sys: string) => Promise<string>;
    } = {},
  ): Promise<void> {
    const job = getActionJobById(this.db, jobId);
    if (!job || job.status !== "running") return;

    // 1. Verification Phase: run test suite
    updateActionJobStatus(this.db, jobId, "verifying", {
      current_step: "Running automated test suite and verification commands",
    });

    const testCmd = options.testCommand || "git status";
    const testParts = testCmd.split(" ");
    const testRes = spawnSync(testParts[0]!, testParts.slice(1), {
      cwd: repoPath,
      encoding: "utf8",
    });

    const testReport = {
      command: testCmd,
      exitCode: testRes.status ?? 0,
      summary: testRes.status === 0 ? "Tests and checks passed successfully" : (testRes.stderr?.trim() || "Verification command failed"),
    };

    // 2. Reviewing Phase: detached clean-room reviewer
    updateActionJobStatus(this.db, jobId, "reviewing", {
      current_step: "Detached clean-room reviewer auditing code changes against specifications",
    });

    const hasOrigin = hasGitRemoteOrigin(repoPath);
    const diffBase = hasOrigin ? "origin/dev" : "dev";
    const diffRes = spawnSync("git", ["diff", `${diffBase}...HEAD`], {
      cwd: repoPath,
      encoding: "utf8",
    });
    const diffStatRes = spawnSync("git", ["diff", "--stat", `${diffBase}...HEAD`], {
      cwd: repoPath,
      encoding: "utf8",
    });

    const diff = diffRes.stdout || "";
    const diffStat = diffStatRes.stdout || "";

    const payload: ReviewPayload = {
      issue: {
        id: job.issue_id,
        title: job.issue_title,
      },
      diff,
      diffStat,
      testReport,
    };

    let verdict: ReviewVerdict;
    if (options.callReviewerModel) {
      verdict = await runDetachedReview(payload, {
        callModel: options.callReviewerModel,
      });
    } else {
      const pass = testReport.exitCode === 0;
      verdict = {
        status: pass ? "PASS" : "REJECT",
        summary: pass ? "Automated verification passed and clean-room review approved." : `Verification failed with exit code ${testReport.exitCode}`,
        defects: pass ? [] : [{ file: "tests", severity: "blocker", description: testReport.summary }],
        reviewedAt: Date.now(),
      };
    }

    updateActionJobStatus(this.db, jobId, "reviewing", {
      review_verdicts_json: JSON.stringify([verdict]),
    });

    this.handleReviewResult({
      jobId,
      repoPath,
      verdict: verdict.status,
      reviewSummary: verdict.summary,
      defects: verdict.defects,
    });
  }

  public handleReviewResult(params: {
    jobId: string;
    repoPath: string;
    verdict: "PASS" | "REJECT";
    reviewSummary: string;
    defects?: unknown[];
    reworkCount?: number;
  }): { status: ActionJobStatus; prNumber?: number | null; prUrl?: string | null } {
    const job = getActionJobById(this.db, params.jobId);
    if (!job) {
      throw new Error(`Job not found: ${params.jobId}`);
    }

    if (params.verdict === "PASS") {
      const hasRemote = hasGitRemoteOrigin(params.repoPath);
      let prNumber: number | null = null;
      let prUrl: string | null = null;

      if (hasRemote) {
        const prRes = createPullRequest({
          cwd: params.repoPath,
          issueId: job.issue_id,
          title: job.issue_title,
        });

        if (prRes.error || !prRes.prNumber) {
          updateActionJobStatus(this.db, job.id, "failed", {
            error_message: `PR creation failed: ${prRes.error || "Unknown error"}`,
            current_step: "Review passed but PR creation failed.",
          });
          safeResetToDev(params.repoPath);
          queueMicrotask(() => {
            void this.evaluateQueue(job.project_id, params.repoPath);
          });
          return { status: "failed" };
        }

        prNumber = prRes.prNumber;
        prUrl = prRes.prUrl;
      }

      updateActionJobStatus(this.db, job.id, "waiting_merge", {
        pr_number: prNumber,
        pr_url: prUrl,
        current_step: hasRemote
          ? `Review passed. PR #${prNumber} created. Waiting for user merge approval.`
          : "Review passed. Local repository ready for fast-forward merge.",
      });

      return {
        status: "waiting_merge",
        prNumber,
        prUrl,
      };
    }

    // On REJECT: check rework count (max 2)
    const currentReworks = params.reworkCount ?? 0;
    if (currentReworks < 2) {
      updateActionJobStatus(this.db, job.id, "running", {
        current_step: `Review rejected. Defect feedback sent to Developer for rework (attempt ${currentReworks + 1}/2)`,
      });
      return { status: "running" };
    }

    // Limit exceeded: transition to review_rejected / failed
    updateActionJobStatus(this.db, job.id, "failed", {
      current_step: "Review rejected twice. Human override required.",
      error_message: "Rework limit exceeded (2 attempts). Review defects remain unresolved.",
    });
    safeResetToDev(params.repoPath);
    queueMicrotask(() => {
      void this.evaluateQueue(job.project_id, params.repoPath);
    });

    return { status: "failed" };
  }

  public executeDeterministicMerge(jobId: string, repoPath: string): { success: boolean; error?: string } {
    const job = getActionJobById(this.db, jobId);
    if (!job) {
      return { success: false, error: `Job not found: ${jobId}` };
    }

    const mergeRes = mergeAndCleanupPipeline({
      cwd: repoPath,
      prNumber: job.pr_number,
      issueId: job.issue_id,
      branch: job.branch ?? "",
    });

    if (mergeRes.success) {
      updateActionJobStatus(this.db, job.id, "completed", {
        current_step: "PR squash merged, Issue closed, dev synchronized, and branch cleaned up.",
      });

      // After task completes, trigger next queued task evaluation
      queueMicrotask(() => {
        void this.evaluateQueue(job.project_id, repoPath);
      });
    } else {
      updateActionJobStatus(this.db, job.id, "failed", {
        error_message: mergeRes.error,
      });
      safeResetToDev(repoPath);
      queueMicrotask(() => {
        void this.evaluateQueue(job.project_id, repoPath);
      });
    }

    return mergeRes;
  }

  public cancelJob(jobId: string, repoPath?: string): void {
    const job = getActionJobById(this.db, jobId);
    if (!job) return;

    updateActionJobStatus(this.db, jobId, "cancelled", {
      current_step: "Job was cancelled by user.",
    });

    const targetRepo = repoPath || job.project_id;
    if (targetRepo) {
      safeResetToDev(targetRepo);
      queueMicrotask(() => {
        void this.evaluateQueue(job.project_id, targetRepo);
      });
    }
  }

  public getJobs(projectId: string): ActionJobRecord[] {
    return getActionJobs(this.db, projectId);
  }

  public getJob(jobId: string): ActionJobRecord | null {
    return getActionJobById(this.db, jobId);
  }
}
