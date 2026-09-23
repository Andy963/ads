import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { Database as DatabaseType } from "better-sqlite3";

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
        const branchCheck = spawnSync("git", ["checkout", "-b", nextJob.branch], {
          cwd: repoPath,
          encoding: "utf8",
        });
        if (branchCheck.status !== 0) {
          // If branch already exists (e.g. rework), check it out directly
          spawnSync("git", ["checkout", nextJob.branch], {
            cwd: repoPath,
            encoding: "utf8",
          });
        }
      }

      updateActionJobStatus(this.db, nextJob.id, "running", {
        current_step: "Developer executing implementation on feature branch",
      });

      return {
        allowed: true,
        dequeuedJobId: nextJob.id,
      };
    } finally {
      this.processingProjects.delete(projectId);
    }
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
      const prRes = createPullRequest({
        cwd: params.repoPath,
        issueId: job.issue_id,
        title: job.issue_title,
      });

      updateActionJobStatus(this.db, job.id, "waiting_merge", {
        pr_number: prRes.prNumber,
        pr_url: prRes.prUrl,
        current_step: "Review passed. Waiting for user merge approval.",
      });

      return {
        status: "waiting_merge",
        prNumber: prRes.prNumber,
        prUrl: prRes.prUrl,
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
    }

    return mergeRes;
  }

  public cancelJob(jobId: string): void {
    updateActionJobStatus(this.db, jobId, "cancelled", {
      current_step: "Job was cancelled by user.",
    });
  }

  public getJobs(projectId: string): ActionJobRecord[] {
    return getActionJobs(this.db, projectId);
  }

  public getJob(jobId: string): ActionJobRecord | null {
    return getActionJobById(this.db, jobId);
  }
}

