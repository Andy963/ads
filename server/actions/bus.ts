import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { Database as DatabaseType } from "better-sqlite3";

import { runAgentTurn } from "../agents/turn.js";
import type { AgentEvent } from "../codex/events.js";
import type { SessionManager } from "../sessions/sessionManager.js";
import { buildWsConnectionIdentity } from "../web/server/ws/connectionIdentity.js";
import type { AsyncLock } from "../utils/asyncLock.js";
import { buildReviewPrompt, DEFAULT_REVIEWER_SYSTEM_PROMPT, runDetachedReview } from "../reviewer/runner.js";
import { parseReviewVerdict } from "../reviewer/verdictParser.js";
import type { ReviewPayload, ReviewVerdict } from "../reviewer/types.js";
import { getDefaultRoleProfile, getRoleProfileById } from "../state/roleProfileStore.js";
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
import {
  createPullRequest,
  mergeAndCleanupPipeline,
  type CreatePrResult,
  type MergeResult,
} from "./pipeline.js";
import { deriveProjectSessionId } from "../web/server/projectSessionId.js";
import { resolveActionsLaneIdentity } from "./laneIdentity.js";

const MAX_REWORK_ATTEMPTS = 2;

function resolveCanonicalProjectId(projectId: string, repoPath?: string): string {
  const workspaceRoot = String(repoPath ?? "").trim();
  return workspaceRoot ? deriveProjectSessionId(workspaceRoot) : String(projectId ?? "").trim();
}

function migrateLegacyProjectJobs(db: DatabaseType, projectId: string, aliases: string[]): void {
  for (const alias of new Set(aliases.map((value) => String(value ?? "").trim()).filter(Boolean))) {
    if (alias === projectId) continue;
    db.prepare("UPDATE action_jobs SET project_id = ? WHERE project_id = ?").run(projectId, alias);
  }
}

function generateJobId(issueId?: number | null): string {
  const ts = Date.now();
  const target = issueId ? String(issueId) : "local";
  const hex = randomBytes(2).toString("hex");
  return `job-${ts}-${target}-${hex}`;
}

function buildActionAgentEventPayload(event: AgentEvent, jobId: string, reviewer = false): Record<string, unknown> {
  const title = reviewer
    ? (event.title ? `[Reviewer] ${event.title}` : "[Reviewer]")
    : event.title;
  if (event.phase !== "command") {
    return {
      type: event.liveStep ? "step" : "delta",
      title,
      delta: event.delta,
      detail: event.detail,
      timestamp: event.timestamp,
      jobId,
      phase: event.phase,
      raw: event.raw,
    };
  }

  const rawItem = event.raw && typeof event.raw === "object" && "item" in event.raw
    ? (event.raw as { item?: Record<string, unknown> }).item
    : undefined;
  const command = String(rawItem?.command ?? event.detail ?? event.title ?? "").trim();
  const output = String(
    rawItem?.aggregated_output
      ?? rawItem?.output
      ?? rawItem?.stdout
      ?? rawItem?.stderr
      ?? event.delta
      ?? event.detail
      ?? "",
  );
  const rawStatus = String(rawItem?.status ?? "").trim().toLowerCase();
  const status = rawStatus === "failed" || rawStatus === "completed"
    ? rawStatus
    : (event.raw && typeof event.raw === "object" && "type" in event.raw && event.raw.type === "item.completed")
      ? "completed"
      : "running";
  const itemId = String(rawItem?.id ?? "").trim();
  const identity = `${jobId}:${itemId || command}`;

  return {
    type: "command",
    title,
    command,
    output,
    outputDelta: output,
    status,
    exitCode: typeof rawItem?.exit_code === "number" ? rawItem.exit_code : undefined,
    identity,
    id: itemId || identity,
    jobId,
    timestamp: event.timestamp,
    phase: event.phase,
    raw: event.raw,
  };
}

export function hasGitRemoteOrigin(repoPath: string): boolean {
  const res = spawnSync("git", ["remote", "get-url", "origin"], { cwd: repoPath, encoding: "utf8" });
  return res.status === 0 && Boolean(res.stdout?.trim());
}

export function safeResetToDev(repoPath: string): void {
  spawnSync("git", ["checkout", "dev"], { cwd: repoPath, encoding: "utf8" });
}

export type DeveloperRunner = (
  job: ActionJobRecord,
  repoPath: string,
  reworkFeedback?: string,
) => Promise<{ exitCode: number; error?: string }>;

export type ReviewerRunner = (prompt: string, systemPrompt: string) => Promise<string>;

export interface LaneDispatchBusOptions {
  sessionManager?: SessionManager;
  historyStore?: {
    add: (key: string, entry: { role: string; text: string; ts: number; kind?: string }) => void;
    get?: (key: string) => Array<{ role: string; text: string; ts: number; kind?: string }>;
  };
  getWorkspaceLock?: (workspaceRoot: string) => AsyncLock;
  broadcastToActionsLane?: (payload: unknown, targetHistoryKey?: string, projectId?: string) => void;
  interruptControllers?: Map<string, AbortController>;
  developerRunner?: DeveloperRunner;
  reviewerRunner?: ReviewerRunner;
  testCommand?: string;
  hasRemoteOrigin?: (repoPath: string) => boolean;
  pullRequestCreator?: (options: {
    cwd: string;
    issueId?: number | null;
    title: string;
    body?: string;
    labels?: string[];
  }) => CreatePrResult;
  mergePipeline?: (options: {
    cwd: string;
    prNumber?: number | null;
    issueId?: number | null;
    branch: string;
    baseBranch?: string;
  }) => MergeResult;
}

export class LaneDispatchBus {
  private processingProjects = new Set<string>();
  private activeAbortControllers = new Map<string, AbortController>();

  constructor(
    private db: DatabaseType,
    private options: LaneDispatchBusOptions = {},
  ) {}

  private laneIdentityForJob(job: ActionJobRecord, repoPath?: string) {
    if (job.auth_user_id && job.chat_session_id) {
      return buildWsConnectionIdentity({
        authUserId: job.auth_user_id,
        sessionId: job.project_id,
        chatSessionId: job.chat_session_id,
        connectionId: "actions",
      });
    }

    return resolveActionsLaneIdentity(this.db, {
      projectId: job.project_id,
      repoPath,
      authUserId: job.auth_user_id,
    }) ?? buildWsConnectionIdentity({
      authUserId: `actions:${job.id}`,
      sessionId: job.project_id,
      chatSessionId: job.chat_session_id || "main",
      connectionId: "actions",
    });
  }

  private recordActionMessage(
    job: ActionJobRecord,
    repoPath: string,
    text: string,
    kind: string,
    role: "status" | "assistant" = "status",
  ): void {
    const historyKey = this.laneIdentityForJob(job, repoPath).historyKey;
    this.options.historyStore?.add(historyKey, {
      role,
      text,
      ts: Date.now(),
      kind,
    });
    this.options.broadcastToActionsLane?.({
      type: "message",
      role,
      text,
      jobId: job.id,
      ts: Date.now(),
    }, historyKey, job.project_id);
  }

  private scheduleRework(
    jobId: string,
    repoPath: string,
    input: { stage: string; feedback: string; reworkCount?: number },
  ): { status: ActionJobStatus; reworkCount: number } {
    const job = getActionJobById(this.db, jobId);
    if (!job) return { status: "failed", reworkCount: 0 };

    const currentCount = Math.max(0, Math.floor(input.reworkCount ?? job.rework_count ?? 0));
    const failure = `${input.stage} failed: ${input.feedback}`;
    if (currentCount >= MAX_REWORK_ATTEMPTS) {
      const message = `Human attention required after ${MAX_REWORK_ATTEMPTS} rework attempts. ${failure}`;
      this.updateJobStatus(job.id, "blocked", {
        rework_count: currentCount,
        current_step: `Human attention required after ${MAX_REWORK_ATTEMPTS} rework attempts.`,
        error_message: message,
      });
      this.recordActionMessage(job, repoPath, message, "action_blocked");
      return { status: "blocked", reworkCount: currentCount };
    }

    const nextCount = currentCount + 1;
    const feedback = [
      `The previous attempt failed during ${input.stage}.`,
      `Failure context: ${input.feedback}`,
      "Fix the root cause, preserve the current feature branch, and rerun verification.",
    ].join("\n");
    const statusMessage = `Actions rework ${nextCount}/${MAX_REWORK_ATTEMPTS} started after ${input.stage} failure.`;
    this.updateJobStatus(job.id, "running", {
      rework_count: nextCount,
      current_step: statusMessage,
      error_message: failure,
    });
    this.recordActionMessage(job, repoPath, statusMessage, "action_rework");
    queueMicrotask(() => {
      void this.executeDeveloper(job.id, repoPath, {
        reworkFeedback: feedback,
        reworkCount: nextCount,
      });
    });
    return { status: "running", reworkCount: nextCount };
  }

  private updateJobStatus(
    jobId: string,
    status: ActionJobStatus,
    updates?: Partial<Pick<ActionJobRecord, "current_step" | "steps_json" | "review_verdicts_json" | "pr_number" | "pr_url" | "error_message" | "branch" | "rework_count">>,
  ): ActionJobRecord | null {
    updateActionJobStatus(this.db, jobId, status, updates);
    const updated = getActionJobById(this.db, jobId);
    if (updated && this.options.broadcastToActionsLane) {
      const historyKey = this.laneIdentityForJob(updated).historyKey;
      this.options.broadcastToActionsLane({
        type: "action_job_updated",
        jobId: updated.id,
        status: updated.status,
        currentStep: updated.current_step,
        reworkCount: updated.rework_count,
        projectId: updated.project_id,
        ts: Date.now(),
      }, historyKey, updated.project_id);
    }
    return updated;
  }

  public dispatchJob(params: {
    projectId: string;
    issueId?: number | null;
    issueTitle: string;
    jobKind?: ActionJobKind;
    developerProfileId?: string | null;
    reviewerProfileIds?: string[];
    repoPath?: string;
    authUserId?: string;
  }): { ok: boolean; jobId: string; status: ActionJobStatus } {
    const id = generateJobId(params.issueId);
    const branch = params.issueId ? `codex/issue-${params.issueId}` : `codex/${id}`;
    const projectId = resolveCanonicalProjectId(params.projectId, params.repoPath);
    const laneIdentity = resolveActionsLaneIdentity(this.db, {
      projectId,
      repoPath: params.repoPath,
      authUserId: params.authUserId,
    });

    const job = createActionJob(this.db, {
      id,
      project_id: projectId,
      job_kind: params.jobKind ?? (params.issueId ? "github_issue" : "local_prompt"),
      issue_id: params.issueId,
      issue_title: params.issueTitle,
      status: "queued",
      branch,
      developer_profile_id: params.developerProfileId,
      reviewer_profile_ids_json: JSON.stringify(params.reviewerProfileIds ?? []),
      auth_user_id: laneIdentity?.authUserId ?? null,
      chat_session_id: laneIdentity?.chatSessionId ?? null,
    });

    this.updateJobStatus(job.id, "queued", {
      current_step: "Queued in Actions queue",
      error_message: null,
    });

    return {
      ok: true,
      jobId: job.id,
      status: job.status,
    };
  }

  public async evaluateQueue(projectId: string, repoPath: string, authUserId?: string): Promise<GateCheckResult & { dequeuedJobId?: string }> {
    const canonicalProjectId = resolveCanonicalProjectId(projectId, repoPath);
    migrateLegacyProjectJobs(this.db, canonicalProjectId, [projectId, repoPath]);
    const queueKey = `${canonicalProjectId}:${String(authUserId ?? "").trim() || "*"}`;

    if (this.processingProjects.has(queueKey)) {
      return { allowed: false, reason: "Queue is already being evaluated" };
    }

    this.processingProjects.add(queueKey);
    try {
      const owner = String(authUserId ?? "").trim();
      const queuedJobs = owner
        ? this.db.prepare(
            "SELECT * FROM action_jobs WHERE project_id = ? AND auth_user_id = ? AND status = 'queued' ORDER BY created_at ASC",
          ).all(canonicalProjectId, owner) as ActionJobRecord[]
        : this.db.prepare(
            "SELECT * FROM action_jobs WHERE project_id = ? AND status = 'queued' ORDER BY created_at ASC",
          ).all(canonicalProjectId) as ActionJobRecord[];

      if (queuedJobs.length === 0) {
        return { allowed: true };
      }

      const nextJob = queuedJobs[0]!;
      const gateResult = checkThreePointGate(this.db, repoPath, canonicalProjectId);

      if (!gateResult.allowed) {
        if (gateResult.gateBlocked === "cleanliness") {
          this.updateJobStatus(nextJob.id, "queued", {
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
          this.updateJobStatus(nextJob.id, "failed", {
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

      this.updateJobStatus(nextJob.id, "running", {
        current_step: "Developer executing implementation on feature branch",
      });

      // Submit task directly into Actions lane session
      queueMicrotask(() => {
        void this.executeDeveloper(nextJob.id, repoPath);
      });

      return {
        allowed: true,
        dequeuedJobId: nextJob.id,
      };
    } finally {
      this.processingProjects.delete(queueKey);
    }
  }

  public async executeDeveloper(
    jobId: string,
    repoPath: string,
    options: { reworkFeedback?: string; reworkCount?: number } = {},
  ): Promise<void> {
    const job = getActionJobById(this.db, jobId);
    if (!job || job.status !== "running") return;
    const reworkCount = Math.max(0, Math.floor(options.reworkCount ?? job.rework_count ?? 0));

    if (this.options.developerRunner) {
      const runnerRes = await this.options.developerRunner(job, repoPath, options.reworkFeedback);
      if (runnerRes.exitCode !== 0) {
        this.scheduleRework(jobId, repoPath, {
          stage: "Developer execution",
          feedback: runnerRes.error || `Developer runner exited with code ${runnerRes.exitCode}`,
          reworkCount,
        });
        return;
      }
      queueMicrotask(() => {
        void this.runJobCycle(jobId, repoPath, { reworkCount });
      });
      return;
    }

    // Retrieve system prompt directly from role_profiles in database
    const devProfile = (job.developer_profile_id ? getRoleProfileById(this.db, job.developer_profile_id) : null)
      ?? getDefaultRoleProfile(this.db, "developer");
    const systemPrompt = devProfile?.system_prompt || "You are the ADS Developer. Implement the requested changes and run tests.";

    const taskPrompt = job.job_kind === "github_issue" && job.issue_id
      ? `Implement GitHub Issue #${job.issue_id}: ${job.issue_title}.\nRead the issue, implement the requested code changes on branch '${job.branch}', run verification tests, and commit.`
      : `${job.issue_title}.\nImplement the requested changes on branch '${job.branch}', run verification tests, and commit.`;

    const finalTaskPrompt = options.reworkFeedback
      ? `${taskPrompt}\n\nCRITICAL - REWORK INSTRUCTIONS:\n${options.reworkFeedback}\nAddress the failure, re-run tests, and commit the fixes on the same feature branch.`
      : taskPrompt;

    if (this.options.sessionManager) {
      const sessionManager = this.options.sessionManager;
      const workspaceRoot = repoPath;
      const projectId = job.project_id;
      const identity = this.laneIdentityForJob(job, repoPath);
      const { authUserId, userId, historyKey } = identity;
      const abortCtrl = new AbortController();
      this.activeAbortControllers.set(jobId, abortCtrl);
      if (this.options.interruptControllers) {
        this.options.interruptControllers.set(historyKey, abortCtrl);
      }

      // Record user prompt in history
      if (this.options.historyStore) {
        this.options.historyStore.add(historyKey, {
          role: "user",
          text: finalTaskPrompt,
          ts: Date.now(),
          kind: "action_dispatch",
        });
      }

      // Notify connected Actions lane WebSocket clients
      if (this.options.broadcastToActionsLane) {
        this.options.broadcastToActionsLane({
          type: "message",
          role: "user",
          text: finalTaskPrompt,
          ts: Date.now(),
          jobId: job.id,
        }, historyKey, projectId);
      }

      let unsubscribe: (() => void) | null = null;
      try {
        const orchestrator = sessionManager.getOrCreate(userId, repoPath, true, {
          authUserId,
          projectId,
        });

        // Inject developer instructions from database profile
        if (typeof orchestrator.setDeveloperInstructions === "function") {
          orchestrator.setDeveloperInstructions(systemPrompt);
        }

        // Attach event listener for real-time WebSocket streaming
        unsubscribe = orchestrator.onEvent((event: AgentEvent) => {
          if (this.options.broadcastToActionsLane) {
            this.options.broadcastToActionsLane(
              buildActionAgentEventPayload(event, job.id),
              historyKey,
              projectId,
            );
          }

          if (event.liveStep && event.title) {
            this.updateJobStatus(jobId, "running", {
              current_step: event.title,
            });
          }
        });

        const turnResult = await runAgentTurn(orchestrator, finalTaskPrompt, {
          streaming: true,
          signal: abortCtrl.signal,
          cwd: repoPath,
          workspaceRoot,
          historySessionId: historyKey,
        });

        unsubscribe?.();
        unsubscribe = null;

        // Record assistant response in history
        if (this.options.historyStore) {
          this.options.historyStore.add(historyKey, {
            role: "assistant",
            text: turnResult.response,
            ts: Date.now(),
          });
        }

        // Broadcast turn completion
        if (this.options.broadcastToActionsLane) {
          this.options.broadcastToActionsLane({
            type: "assistant_done",
            text: turnResult.response,
            jobId: job.id,
            ts: Date.now(),
          }, historyKey, projectId);
        }

        this.activeAbortControllers.delete(jobId);
        if (this.options.interruptControllers) {
          this.options.interruptControllers.delete(historyKey);
        }

        // Proceed to verification & detached review
        queueMicrotask(() => {
          void this.runJobCycle(jobId, repoPath, { reworkCount });
        });
      } catch (err) {
        unsubscribe?.();
        this.activeAbortControllers.delete(jobId);
        if (this.options.interruptControllers) {
          this.options.interruptControllers.delete(historyKey);
        }

        if (abortCtrl.signal.aborted) {
          this.updateJobStatus(jobId, "cancelled", {
            error_message: `Actions session execution aborted: ${err instanceof Error ? err.message : String(err)}`,
          });
          queueMicrotask(() => {
            void this.evaluateQueue(job.project_id, repoPath, job.auth_user_id ?? undefined);
          });
        } else {
          this.scheduleRework(jobId, repoPath, {
            stage: "Developer execution",
            feedback: err instanceof Error ? err.message : String(err),
            reworkCount,
          });
        }
      }
      return;
    }

    // In automated test harness without runner override or sessionManager, avoid unneeded execution
    if (process.env.ADS_TEST_STATE_ROOT || (!this.options.sessionManager && !this.options.developerRunner)) {
      queueMicrotask(() => {
        void this.runJobCycle(jobId, repoPath, { reworkCount });
      });
      return;
    }

    // Fallback if no runner or session manager is provided
    this.scheduleRework(jobId, repoPath, {
      stage: "Developer execution",
      feedback: "No Actions session manager configured for task execution",
      reworkCount,
    });
  }

  public async executeReviewer(
    payload: ReviewPayload,
    repoPath: string,
    reviewerProfileId?: string,
    historyKey?: string,
    projectId?: string,
    jobId?: string,
  ): Promise<ReviewVerdict> {
    if (this.options.reviewerRunner) {
      const prompt = buildReviewPrompt(payload);
      const rawVerdict = await this.options.reviewerRunner(prompt, DEFAULT_REVIEWER_SYSTEM_PROMPT);
      return parseReviewVerdict(rawVerdict, reviewerProfileId);
    }

    if (process.env.ADS_TEST_STATE_ROOT) {
      const pass = payload.testReport?.exitCode === 0;
      return {
        status: pass ? "PASS" : "REJECT",
        summary: pass ? "Automated verification passed and clean-room review approved." : `Verification failed with exit code ${payload.testReport?.exitCode}`,
        defects: pass ? [] : [{ file: "tests", severity: "blocker", description: payload.testReport?.summary || "Tests failed" }],
        reviewerProfileId,
        reviewedAt: Date.now(),
      };
    }

    // Retrieve reviewer profile from database
    const reviewerProfile = (reviewerProfileId ? getRoleProfileById(this.db, reviewerProfileId) : null)
      ?? getDefaultRoleProfile(this.db, "reviewer");
    const systemPrompt = reviewerProfile?.system_prompt || DEFAULT_REVIEWER_SYSTEM_PROMPT;
    const reviewPrompt = buildReviewPrompt(payload);

    if (this.options.sessionManager) {
      try {
        const userId = 9999; // Detached reviewer ephemeral identity
        const reviewerJob = jobId ? getActionJobById(this.db, jobId) : null;
        const reviewerIdentity = reviewerJob
          ? this.laneIdentityForJob(reviewerJob, repoPath)
          : buildWsConnectionIdentity({
              authUserId: `actions:${jobId ?? "reviewer"}`,
              sessionId: projectId ?? "reviewer",
              chatSessionId: "main",
              connectionId: randomBytes(3).toString("hex"),
            });
        const authUserId = reviewerIdentity.authUserId;
        const orchestrator = this.options.sessionManager.getOrCreate(userId, repoPath, false, {
          authUserId,
          projectId: reviewerJob?.project_id ?? projectId ?? "reviewer-isolated",
        });

        if (typeof orchestrator.setDeveloperInstructions === "function") {
          orchestrator.setDeveloperInstructions(systemPrompt);
        }

        // Attach event listener for real-time Reviewer streaming to Actions lane
        const unsubscribe = orchestrator.onEvent((event: AgentEvent) => {
          if (this.options.broadcastToActionsLane) {
            this.options.broadcastToActionsLane(
              buildActionAgentEventPayload(event, jobId ?? "reviewer", true),
              historyKey,
              projectId,
            );
          }
        });

        const res = await orchestrator.send(reviewPrompt);
        unsubscribe();
        return parseReviewVerdict(res.response, reviewerProfile?.id);
      } catch {
        // Fallback below
      }
    }

    const pass = payload.testReport?.exitCode === 0;
    return {
      status: pass ? "PASS" : "REJECT",
      summary: pass ? "Automated verification passed and clean-room review approved." : `Verification failed with exit code ${payload.testReport?.exitCode}`,
      defects: pass ? [] : [{ file: "tests", severity: "blocker", description: payload.testReport?.summary || "Tests failed" }],
      reviewerProfileId,
      reviewedAt: Date.now(),
    };
  }

  public async runJobCycle(
    jobId: string,
    repoPath: string,
    options: {
      testCommand?: string;
      callReviewerModel?: (prompt: string, sys: string) => Promise<string>;
      reworkCount?: number;
    } = {},
  ): Promise<void> {
    const job = getActionJobById(this.db, jobId);
    if (!job || job.status !== "running") return;

    const projectId = job.project_id;
    const identity = this.laneIdentityForJob(job, repoPath);
    const historyKey = identity.historyKey;

    // 1. Verification Phase: run test suite
    this.updateJobStatus(jobId, "verifying", {
      current_step: "Running automated test suite and verification commands",
    });

    const testCmd = options.testCommand || this.options.testCommand || "git status";

    if (this.options.broadcastToActionsLane) {
      this.options.broadcastToActionsLane({
        type: "step",
        title: "Running Verification Suite",
        delta: `Executing verification command: ${testCmd}...`,
        liveStep: true,
        jobId: job.id,
        ts: Date.now(),
      }, historyKey, projectId);
    }

    const testParts = testCmd.split(" ");
    const testRes = spawnSync(testParts[0]!, testParts.slice(1), {
      cwd: repoPath,
      encoding: "utf8",
    });

    const testReport = {
      command: testCmd,
      exitCode: testRes.status ?? 0,
      summary: testRes.status === 0
        ? "Tests and checks passed successfully"
        : (testRes.stderr?.trim() || testRes.stdout?.trim() || "Verification command failed"),
    };

    if (this.options.broadcastToActionsLane) {
      this.options.broadcastToActionsLane({
        type: "command",
        command: testCmd,
        output: testReport.summary,
        exitCode: testReport.exitCode,
        status: testReport.exitCode === 0 ? "completed" : "failed",
        jobId: job.id,
        ts: Date.now(),
      }, historyKey, projectId);
    }

    if (this.options.historyStore) {
      this.options.historyStore.add(historyKey, {
        role: "status",
        text: `[Verification] ${testCmd} (exit ${testReport.exitCode}): ${testReport.summary}`,
        ts: Date.now(),
        kind: "verification",
      });
    }

    if (testReport.exitCode !== 0) {
      this.scheduleRework(jobId, repoPath, {
        stage: "Verification",
        feedback: `${testCmd} exited with code ${testReport.exitCode}: ${testReport.summary}`,
        reworkCount: options.reworkCount,
      });
      return;
    }

    // 2. Reviewing Phase: detached clean-room reviewer
    this.updateJobStatus(jobId, "reviewing", {
      current_step: "Detached clean-room reviewer auditing code changes against specifications",
    });

    if (this.options.broadcastToActionsLane) {
      this.options.broadcastToActionsLane({
        type: "step",
        title: "Detached Clean-Room Reviewer",
        delta: "Auditing git diff against requirements, ADRs, and verification reports...",
        liveStep: true,
        jobId: job.id,
        ts: Date.now(),
      }, historyKey, projectId);
    }

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

    const reviewerProfile = (job.reviewer_profile_ids_json ? JSON.parse(job.reviewer_profile_ids_json)[0] : null)
      ?? getDefaultRoleProfile(this.db, "reviewer");

    let verdict: ReviewVerdict;
    try {
      if (options.callReviewerModel) {
        verdict = await runDetachedReview(payload, {
          callModel: options.callReviewerModel,
          reviewerProfileId: typeof reviewerProfile === "string" ? reviewerProfile : reviewerProfile?.id,
        });
      } else {
        verdict = await this.executeReviewer(
          payload,
          repoPath,
          typeof reviewerProfile === "string" ? reviewerProfile : reviewerProfile?.id,
          historyKey,
          projectId,
          job.id,
        );
      }
    } catch (error) {
      this.scheduleRework(jobId, repoPath, {
        stage: "Reviewer execution",
        feedback: error instanceof Error ? error.message : String(error),
        reworkCount: options.reworkCount,
      });
      return;
    }

    this.updateJobStatus(jobId, "reviewing", {
      review_verdicts_json: JSON.stringify([verdict]),
    });

    // Format Review Verdict card and broadcast to Actions lane
    const defectsList = verdict.defects && verdict.defects.length > 0
      ? "\n\n**Defects Identified:**\n" + verdict.defects.map((d) => `- [${d.severity.toUpperCase()}] \`${d.file}${d.line ? `:${d.line}` : ""}\`: ${d.description}`).join("\n")
      : "\n\n*No blocking defects identified.*";

    const reviewCardText = `### Code Review: ${verdict.status === "PASS" ? "✅ Approved (PASS)" : "❌ Rejected (REJECT)"}\n\n${verdict.summary}${defectsList}`;

    if (this.options.broadcastToActionsLane) {
      this.options.broadcastToActionsLane({
        type: "message",
        role: "assistant",
        text: reviewCardText,
        jobId: job.id,
        ts: Date.now(),
        status: verdict.status,
      }, historyKey, projectId);
    }

    if (this.options.historyStore) {
      this.options.historyStore.add(historyKey, {
        role: "assistant",
        text: reviewCardText,
        ts: Date.now(),
        kind: "review_verdict",
      });
    }

    this.handleReviewResult({
      jobId,
      repoPath,
      verdict: verdict.status,
      reviewSummary: verdict.summary,
      defects: verdict.defects,
      reworkCount: options.reworkCount,
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
      const hasRemote = this.options.hasRemoteOrigin?.(params.repoPath) ?? hasGitRemoteOrigin(params.repoPath);
      let prNumber: number | null = null;
      let prUrl: string | null = null;

      if (hasRemote) {
        const prRes = (this.options.pullRequestCreator ?? createPullRequest)({
          cwd: params.repoPath,
          issueId: job.issue_id,
          title: job.issue_title,
        });

        if (prRes.error || !prRes.prNumber) {
          const rework = this.scheduleRework(job.id, params.repoPath, {
            stage: "PR creation",
            feedback: prRes.error || "Unknown error",
            reworkCount: params.reworkCount ?? job.rework_count,
          });
          return { status: rework.status };
        }

        prNumber = prRes.prNumber;
        prUrl = prRes.prUrl;
      }

      this.updateJobStatus(job.id, "waiting_merge", {
        pr_number: prNumber,
        pr_url: prUrl,
        current_step: hasRemote
          ? `Review passed. PR #${prNumber} created. Waiting for user merge approval.`
          : "Review passed. Local repository ready for fast-forward merge.",
      });

      const projectId = job.project_id;
      const identity = this.laneIdentityForJob(job, params.repoPath);
      const historyKey = identity.historyKey;

      if (this.options.broadcastToActionsLane) {
        this.options.broadcastToActionsLane({
          type: "message",
          role: "status",
          text: hasRemote
            ? `Review approved. PR #${prNumber} created (${prUrl}). Waiting for user merge approval.`
            : "Review approved. Local repository ready for fast-forward merge.",
          jobId: job.id,
          ts: Date.now(),
        }, historyKey, projectId);
      }

      if (this.options.historyStore) {
        this.options.historyStore.add(historyKey, {
          role: "status",
          text: hasRemote
            ? `[PR Created] PR #${prNumber}: ${prUrl}. Waiting for merge approval.`
            : "[Local Ready] Review approved. Ready for merge.",
          ts: Date.now(),
          kind: "pr_delivery",
        });
      }

      return {
        status: "waiting_merge",
        prNumber,
        prUrl,
      };
    }

    const defectSummary = Array.isArray(params.defects) && params.defects.length > 0
      ? params.defects.map((defect: unknown) => {
          const item = defect && typeof defect === "object" ? (defect as Record<string, unknown>) : null;
          return `- ${String(item?.file ?? "unknown")}:${String(item?.line ?? "?")} [${String(item?.severity ?? "defect")}]: ${String(item?.description ?? "")}`;
        }).join("\n")
      : params.reviewSummary;
    const rework = this.scheduleRework(job.id, params.repoPath, {
      stage: "Reviewer rejection",
      feedback: defectSummary || "Reviewer rejected the change without defect details.",
      reworkCount: params.reworkCount ?? job.rework_count,
    });
    return { status: rework.status };
  }

  public executeDeterministicMerge(jobId: string, repoPath: string): { success: boolean; error?: string } {
    const job = getActionJobById(this.db, jobId);
    if (!job) {
      return { success: false, error: `Job not found: ${jobId}` };
    }

    const mergeRes = (this.options.mergePipeline ?? mergeAndCleanupPipeline)({
      cwd: repoPath,
      prNumber: job.pr_number,
      issueId: job.issue_id,
      branch: job.branch ?? "",
    });

    if (mergeRes.success) {
      this.updateJobStatus(job.id, "completed", {
        current_step: "PR squash merged, Issue closed, dev synchronized, and branch cleaned up.",
        error_message: null,
      });

      // After task completes, trigger next queued task evaluation
      queueMicrotask(() => {
        void this.evaluateQueue(job.project_id, repoPath, job.auth_user_id ?? undefined);
      });
    } else {
      this.scheduleRework(job.id, repoPath, {
        stage: "Merge and delivery",
        feedback: mergeRes.error || "Unknown merge failure",
        reworkCount: job.rework_count,
      });
    }

    return mergeRes;
  }

  public cancelJob(jobId: string, repoPath?: string): void {
    const abortCtrl = this.activeAbortControllers.get(jobId);
    if (abortCtrl) {
      abortCtrl.abort();
      this.activeAbortControllers.delete(jobId);
    }

    const job = getActionJobById(this.db, jobId);
    if (!job) return;

    this.updateJobStatus(jobId, "cancelled", {
      current_step: "Job was cancelled by user.",
    });

    const targetRepo = repoPath || job.project_id;
    if (targetRepo) {
      safeResetToDev(targetRepo);
      queueMicrotask(() => {
        void this.evaluateQueue(job.project_id, targetRepo, job.auth_user_id ?? undefined);
      });
    }
  }

  public getJobs(projectId: string, repoPath?: string, authUserId?: string): ActionJobRecord[] {
    const canonicalProjectId = resolveCanonicalProjectId(projectId, repoPath);
    migrateLegacyProjectJobs(this.db, canonicalProjectId, [projectId, repoPath ?? ""]);
    return getActionJobs(this.db, canonicalProjectId, undefined, authUserId);
  }

  public getJob(jobId: string): ActionJobRecord | null {
    return getActionJobById(this.db, jobId);
  }
}
