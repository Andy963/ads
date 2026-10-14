import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import type { Database as DatabaseType } from "better-sqlite3";
import type { ActionRecoveryContext } from "../agents/actionTools.js";
import { createActionJob, getActionJobById, type ActionJobKind, type ActionJobRecord } from "../state/actionJobStore.js";
import {
  buildTakeoverPrompt, getActionTakeover, MAX_ACTION_RECOVERY_ROUNDS,
  readTakeoverPrompt, recordActionTakeover, takeoverPromptId,
} from "../state/actionTakeoverStore.js";
import type { EnqueuePromptInput, PromptQueueEntry } from "../state/promptQueueStore.js";
import { hashPromptQueuePayload } from "../state/promptQueueStore.js";
import { buildWsConnectionIdentity } from "../web/server/ws/connectionIdentity.js";
import { ACOPILOT_CHAT_SESSION_ID } from "../web/server/ws/session.js";
import { deriveProjectSessionId } from "../web/server/projectSessionId.js";

const ACOPILOT_NAMESPACE = "web-acopilot";

/** Safe, fixed messages that can be returned to the diagnosing agent. */
export class ActionRecoveryError extends Error {}

export interface RecoveryDispatchInput {
  jobId: string;
  promptId: string;
  repoPath: string;
  authUserId?: string;
  issueId: number | null;
  issueTitle: string;
  issueDescription: string;
  acceptanceCriteria: string[];
  jobKind: ActionJobKind;
}

export interface TakeoverQueue {
  enqueue: (input: EnqueuePromptInput) => unknown;
  get: (id: string) => PromptQueueEntry | null;
  isOwner?: () => boolean;
}

export class ActionTakeoverCoordinator {
  private queue: TakeoverQueue | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pumping = false;

  constructor(private db: DatabaseType, private options: {
    generation: (namespace: string, logicalHistoryKey: string) => number;
    isBusy: (projectId: string, workspace: string) => boolean;
    evaluate: (projectId: string, workspace: string, owner: string) => Promise<unknown>;
    report: (job: ActionJobRecord, message: string) => void;
  }) {}

  start(queue: TakeoverQueue): void {
    this.stop();
    this.queue = queue;
    // Upgrade recovery is scoped to registered owners, never guessed from a path.
    const blocked = this.db.prepare(`SELECT j.* FROM action_jobs j
      JOIN web_projects p ON p.project_id = j.project_id AND p.user_id = j.auth_user_id
      WHERE j.status = 'blocked' ORDER BY j.created_at`).all() as ActionJobRecord[];
    for (const job of blocked) this.db.transaction(() => this.capture(job))();
    this.timer = setInterval(() => { void this.pump(); }, 1000);
    this.timer.unref();
    void this.pump();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.queue = null;
  }

  /** Capture the destination epoch at the handoff, not when a busy worker exits. */
  capture(job: ActionJobRecord): void {
    recordActionTakeover(this.db, job);
    const record = getActionTakeover(this.db, job.id)!;
    const workspace = this.workspace(job);
    if (record.prompt_json || !workspace || !job.auth_user_id || !this.actionsGenerationMatches(job)) return;
    const args = { authUserId: job.auth_user_id, sessionId: job.project_id, chatSessionId: ACOPILOT_CHAT_SESSION_ID };
    const logicalHistoryKey = buildWsConnectionIdentity(args).historyKey;
    const laneGeneration = this.options.generation(ACOPILOT_NAMESPACE, logicalHistoryKey);
    const identity = buildWsConnectionIdentity({ ...args, generation: laneGeneration });
    const prompt: EnqueuePromptInput = {
      ...args, userId: identity.userId, historyKey: identity.historyKey, logicalHistoryKey,
      laneNamespace: ACOPILOT_NAMESPACE, laneGeneration, workspaceRoot: workspace,
      clientMessageId: takeoverPromptId(job.id), createdAt: record.created_at,
      payload: { text: buildTakeoverPrompt(record) },
    };
    this.db.prepare("UPDATE action_takeovers SET prompt_json = ? WHERE job_id = ? AND prompt_json IS NULL")
      .run(JSON.stringify(prompt), job.id);
  }

  recoveryReady(jobId: string): boolean {
    return this.recoveryGate(jobId).allowed;
  }

  recoveryGate(jobId: string): { allowed: boolean; reason?: string } {
    const parent = this.db.prepare("SELECT job_id FROM action_takeovers WHERE successor_job_id = ?")
      .get(jobId) as { job_id: string } | undefined;
    if (!parent) return { allowed: true };
    const entry = this.queue?.get(takeoverPromptId(parent.job_id));
    if (!entry || entry.status !== "completed") return { allowed: false, reason: "Waiting for Acopilot takeover to finish before starting its recovery" };
    try {
      if (!this.contextForPrompt(entry)) throw new ActionRecoveryError("Recovery handoff is unavailable.");
      const job = getActionJobById(this.db, jobId);
      const source = getActionJobById(this.db, parent.job_id);
      if (!job || !source || job.auth_user_id !== entry.authUserId || job.project_id !== entry.sessionId
        || job.chat_session_id !== source.chat_session_id || job.lane_generation !== source.lane_generation) {
        throw new ActionRecoveryError("Recovery job no longer belongs to its authorized owner and lane.");
      }
      this.assertSafeWorkspace(job, entry.workspaceRoot);
      return { allowed: true };
    } catch (error) {
      return { allowed: false, reason: error instanceof ActionRecoveryError ? error.message : "Recovery workspace inspection failed." };
    }
  }

  private workspace(job: ActionJobRecord): string | null {
    if (!job.auth_user_id) return null;
    try {
      const row = this.db.prepare(`SELECT workspace_root FROM web_projects
        WHERE project_id = ? AND user_id = ?`).get(job.project_id, job.auth_user_id) as { workspace_root: string } | undefined;
      return row && deriveProjectSessionId(row.workspace_root) === job.project_id ? row.workspace_root : null;
    } catch { return null; }
  }

  private actionsGenerationMatches(job: ActionJobRecord): boolean {
    if (!job.auth_user_id || !job.chat_session_id) return false;
    const key = buildWsConnectionIdentity({ authUserId: job.auth_user_id, sessionId: job.project_id, chatSessionId: job.chat_session_id }).historyKey;
    return this.options.generation("web-actions", key) === job.lane_generation;
  }

  async pump(): Promise<void> {
    if (!this.queue || this.queue.isOwner?.() === false || this.pumping) return;
    this.pumping = true;
    try {
      const jobs = this.db.prepare(`SELECT j.* FROM action_jobs j JOIN action_takeovers t ON t.job_id = j.id
        WHERE j.status = 'blocked' ORDER BY j.created_at`).all() as ActionJobRecord[];
      for (const job of jobs) {
        if (!this.queue || this.queue.isOwner?.() === false) break;
        const workspace = this.workspace(job);
        if (!workspace || !job.auth_user_id || this.options.isBusy(job.project_id, workspace)) continue;
        const record = getActionTakeover(this.db, job.id)!;
        const report = (message: string) => {
          if (record.error_message === message) return;
          this.db.prepare("UPDATE action_takeovers SET error_message = ? WHERE job_id = ?").run(message, job.id);
          this.options.report(job, message);
        };
        if (!this.actionsGenerationMatches(job)) {
          report("Automatic takeover stopped: the originating Actions lane was reset.");
          continue;
        }
        try {
          const prompt = readTakeoverPrompt(record);
          if (!prompt) continue;
          const entry = this.queue.get(prompt.clientMessageId);
          if (!entry) {
            if (this.options.generation(prompt.laneNamespace, prompt.logicalHistoryKey) !== prompt.laneGeneration) {
              report("Automatic takeover stopped: the Acopilot lane was reset.");
              continue;
            }
            this.queue.enqueue(prompt);
          } else if (entry.status === "failed") {
            report("Automatic takeover did not finish. Inspect the Acopilot diagnosis or retry its interrupted prompt explicitly.");
          } else if (entry.status === "completed") {
            if (record.successor_job_id && this.contextForPrompt(entry)) await this.options.evaluate(job.project_id, workspace, job.auth_user_id);
            else report("Acopilot takeover finished without a recovery dispatch. See its diagnosis for the remaining blocker.");
          }
        } catch (error) {
          report(error instanceof ActionRecoveryError ? error.message
            : "Automatic takeover is waiting for its durable prompt queue or execution preconditions.");
        }
      }
    } finally { this.pumping = false; }
  }

  /** Only a server-created queue row can confer recovery authority; payloads cannot. */
  contextForPrompt(entry: PromptQueueEntry): ActionRecoveryContext | null {
    if (!entry.clientMessageId.startsWith("action-takeover:")) return null;
    const jobId = entry.clientMessageId.slice("action-takeover:".length);
    const record = getActionTakeover(this.db, jobId);
    const prompt = record && readTakeoverPrompt(record);
    const job = getActionJobById(this.db, jobId);
    const { replay_incomplete: _replayIncomplete, ...payload } = entry.payload;
    if (this.queue?.isOwner?.() === false || !prompt || !job || job.status !== "blocked" || !this.actionsGenerationMatches(job)
      || this.workspace(job) !== entry.workspaceRoot
      || prompt.authUserId !== entry.authUserId || prompt.sessionId !== entry.sessionId
      || prompt.chatSessionId !== entry.chatSessionId || prompt.userId !== entry.userId
      || prompt.historyKey !== entry.historyKey || prompt.logicalHistoryKey !== entry.logicalHistoryKey
      || prompt.laneNamespace !== entry.laneNamespace || prompt.laneGeneration !== entry.laneGeneration
      || prompt.workspaceRoot !== entry.workspaceRoot
      // Completed queue rows intentionally discard their payload, retaining its digest.
      || (entry.status === "completed" ? hashPromptQueuePayload(prompt.payload) !== entry.payloadHash : !isDeepStrictEqual(prompt.payload, payload))
      || this.options.generation(entry.laneNamespace, entry.logicalHistoryKey) !== entry.laneGeneration) {
      throw new ActionRecoveryError("Actions takeover no longer belongs to this active owner and lane.");
    }
    return { jobId, promptId: entry.clientMessageId };
  }

  private assertSafeWorkspace(job: ActionJobRecord, workspace: string): void {
    const git = (...args: string[]): string => {
      const res = spawnSync("git", args, { cwd: workspace, encoding: "utf8" });
      if (res.status !== 0) throw new ActionRecoveryError("Recovery workspace inspection failed.");
      return res.stdout.trim();
    };
    const branch = git("branch", "--show-current");
    if (!job.branch || (branch !== "dev" && branch !== job.branch) || git("status", "--porcelain", "-uno")) {
      throw new ActionRecoveryError("Recovery needs a clean dev or assigned feature checkout; existing changes were preserved.");
    }
  }

  dispatch(input: RecoveryDispatchInput): { ok: boolean; jobId: string; status: "queued" } {
    const record = getActionTakeover(this.db, input.jobId);
    const entry = this.queue?.get(input.promptId);
    const context = entry && this.contextForPrompt(entry);
    const job = getActionJobById(this.db, input.jobId);
    if (!record || !job || !context || context.jobId !== job.id || entry?.status !== "running"
      || entry.authUserId !== input.authUserId || entry.workspaceRoot !== input.repoPath) {
      throw new ActionRecoveryError("Recovery dispatch requires the active scoped Acopilot takeover.");
    }
    if (input.issueId !== job.issue_id || input.jobKind !== job.job_kind || !input.issueDescription.trim()) {
      throw new ActionRecoveryError("Recovery must target the same task with concrete correction instructions.");
    }
    if (record.successor_job_id) return { ok: true, jobId: record.successor_job_id, status: "queued" };
    if (record.round > MAX_ACTION_RECOVERY_ROUNDS) throw new ActionRecoveryError("Task-level recovery budget exhausted.");
    if (this.options.isBusy(job.project_id, input.repoPath)) throw new ActionRecoveryError("Previous Developer still owns the workspace.");
    this.assertSafeWorkspace(job, input.repoPath);
    const successorId = `${record.root_job_id}-recovery-${record.round}`;
    this.db.transaction(() => {
      // Copy the original contract, never the model's replacement acceptance criteria.
      const child = createActionJob(this.db, {
        id: successorId, project_id: job.project_id, lane_generation: job.lane_generation,
        job_kind: job.job_kind, issue_id: job.issue_id, issue_title: job.issue_title,
        issue_snapshot: JSON.parse(job.issue_snapshot_json), branch: job.branch, base_sha: job.base_sha,
        developer_profile_id: job.developer_profile_id, reviewer_profile_ids_json: job.reviewer_profile_ids_json,
        auth_user_id: job.auth_user_id, chat_session_id: job.chat_session_id,
      });
      this.db.prepare("UPDATE action_jobs SET pr_number = ?, pr_url = ? WHERE id = ?").run(job.pr_number, job.pr_url, child.id);
      this.db.prepare("UPDATE action_takeovers SET successor_job_id = ?, instruction = ?, error_message = NULL WHERE job_id = ?")
        .run(child.id, input.issueDescription.trim(), job.id);
    })();
    this.options.report(job, `Acopilot dispatched linked recovery ${successorId}; fresh independent Review is required.`);
    // The pump starts it only after Acopilot has finished, not in this tool call.
    return { ok: true, jobId: successorId, status: "queued" };
  }
}
