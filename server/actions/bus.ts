import { createActionSupervision } from "./supervision.js";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { Database as DatabaseType } from "better-sqlite3";

import { runAgentTurn } from "../agents/turn.js";
import type { AgentEvent } from "../codex/events.js";
import type { SessionManager } from "../sessions/sessionManager.js";
import { buildWsConnectionIdentity } from "../web/server/ws/connectionIdentity.js";
import type { AsyncLock } from "../utils/asyncLock.js";
import {
  buildReviewPrompt,
  runDetachedReview,
} from "../reviewer/runner.js";
import { filterDiff, REVIEW_DIFF_MAX_LINES } from "../reviewer/diffFilter.js";
import { extractRelatedContexts } from "../reviewer/contextExtractor.js";
import { ReviewerIncompleteError } from "../reviewer/incomplete.js";
import { runReviewerInspection } from "../reviewer/inspectionRunner.js";
import { createNativeModelResolver, type NativeModelConfig } from "../runtime/modelResolver.js";
import type { completeNativeChat } from "../runtime/openAiCompatibleClient.js";
import type { ReviewPayload, ReviewVerdict } from "../reviewer/types.js";
import { getDefaultRoleProfile, getRoleProfileById } from "../state/roleProfileStore.js";
import {
  createActionJob,
  getActionJobs,
  getActionJobById,
  updateActionJobStatus,
  type ActionJobAttempt,
  type ActionJobRecord,
  type ActionJobIssueSnapshot,
  type ActionJobStatus,
  type ActionJobKind,
} from "../state/actionJobStore.js";
import { checkThreePointGate, type GateCheckResult } from "./threePointGate.js";
import {
  ACTIONS_BASE_BRANCH,
  createPullRequest,
  mergeAndCleanupPipeline,
  readPullRequestState,
  type CreatePrResult,
  type MergeResult,
  type PullRequestStateResult,
} from "./pipeline.js";
import { deriveProjectSessionId } from "../web/server/projectSessionId.js";
import { resolveActionsLaneIdentity } from "./laneIdentity.js";
import { checkActionsRuntimePreflight } from "./runtimePreflight.js";
import { resolveAgentRuntime, type AgentRuntimeBackend } from "../runtime/config.js";

const MAX_REWORK_ATTEMPTS = 3;
const PR_CREATION_ATTEMPTS = 3;
const AUTOMATED_ACTION_EXECUTION_MODE = "automated_action" as const;
const ACTION_EXECUTE_HISTORY_KIND = "action_execute";
const AUTOMATED_ACTION_INSTRUCTIONS = [
  `Execution mode: ${AUTOMATED_ACTION_EXECUTION_MODE}.`,
  "AUTOMATED ACTION MODE: This queued job is already authorized by the user.",
  "Begin implementation immediately on the assigned feature branch.",
  "Do not ask for another goal confirmation and do not wait for interactive approval.",
  "Implement the requested changes, run verification, and commit the implementation before responding.",
].join("\n");

interface ActionJobStep {
  status: ActionJobStatus;
  step: string;
  ts: number;
}

function parseActionJobSteps(value: string | null | undefined): ActionJobStep[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is ActionJobStep => (
      Boolean(entry)
      && typeof entry === "object"
      && typeof (entry as ActionJobStep).step === "string"
      && typeof (entry as ActionJobStep).status === "string"
    ));
  } catch {
    return [];
  }
}

function parseActionJobAttempts(value: string | null | undefined): ActionJobAttempt[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is ActionJobAttempt => (
      Boolean(entry)
      && typeof entry === "object"
      && typeof (entry as ActionJobAttempt).attempt === "number"
      && typeof (entry as ActionJobAttempt).stage === "string"
      && typeof (entry as ActionJobAttempt).failure === "string"
      && typeof (entry as ActionJobAttempt).ts === "number"
    ));
  } catch {
    return [];
  }
}

function formatAttemptLine(entry: ActionJobAttempt): string {
  return `Attempt ${entry.attempt} failed during ${entry.stage}: ${entry.failure}`;
}

function formatAttemptHistory(attempts: ActionJobAttempt[]): string {
  return attempts.map(formatAttemptLine).join("\n");
}

type ActionBlockedClassification = "infrastructure" | "rework-exhausted";

const ACTION_BLOCKED_CLASSIFICATION_LABELS: Record<ActionBlockedClassification, string> = {
  infrastructure: "Infrastructure / External Dependency",
  "rework-exhausted": "Rework Budget Exhausted",
};

function formatActionBlockedCard(input: {
  job: Pick<ActionJobRecord, "id" | "issue_id" | "issue_title">;
  classification: ActionBlockedClassification;
  failureStage: string;
  failure: string;
  attempts?: ActionJobAttempt[];
  guidanceNote: string;
}): string {
  const headerRef = input.job.issue_id != null
    ? `#${input.job.issue_id} ${input.job.issue_title}`.trim()
    : input.job.id;
  const lines = [
    `### 🛑 Task Blocked: ${headerRef}`,
    "",
    `**Block Classification:** ${ACTION_BLOCKED_CLASSIFICATION_LABELS[input.classification]}`,
    `**Failure Stage:** ${input.failureStage}`,
    `**Core Error:** ${input.failure}`,
    "",
  ];
  if (input.attempts && input.attempts.length > 0) {
    lines.push(
      "**Chronological Attempt Breakdown:**",
      ...input.attempts.map((attempt) => `${attempt.attempt}. ${attempt.stage}: ${attempt.failure}`),
      "",
    );
  }
  lines.push(
    "**Operator Resolution Guidance:**",
    `- ${input.guidanceNote}`,
    "- Human intervention is required; automated rework will not resume this task.",
    "- Once the underlying cause is resolved, click **Dismiss** on the top queue stack to clear this blocked task.",
  );
  return lines.join("\n");
}

function buildExecuteHistoryText(command: string, output: string): string {
  const normalizedCommand = String(command ?? "").trim() || "command";
  const normalizedOutput = String(output ?? "").replace(/\r\n/g, "\n").trim();
  return normalizedOutput ? `$ ${normalizedCommand}\n${normalizedOutput}` : `$ ${normalizedCommand}`;
}

function isTerminalCommandPayload(payload: Record<string, unknown>): boolean {
  const status = String(payload.status ?? "").trim().toLowerCase();
  return status === "completed" || status === "failed" || status === "declined" || status === "cancelled";
}

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
  if (reviewer && event.phase === "responding") {
    return {};
  }

  const title = reviewer
    ? (event.title ? `[Reviewer] ${event.title}` : "[Reviewer]")
    : event.title;
  if (event.phase === "responding") {
    const payload: Record<string, unknown> = {
      type: "delta",
      title,
      delta: event.delta,
      detail: event.detail,
      timestamp: event.timestamp,
      jobId,
      phase: event.phase,
    };
    if (!reviewer) payload.raw = event.raw;
    return payload;
  }

  const rawItem = event.raw && typeof event.raw === "object" && "item" in event.raw
    ? (event.raw as { item?: Record<string, unknown> }).item
    : undefined;
  const eventType = event.raw && typeof event.raw === "object" && "type" in event.raw
    ? String(event.raw.type)
    : "";
  const itemId = String(rawItem?.id ?? "").trim();

  if (!reviewer && event.phase === "editing") {
    const changes = Array.isArray(rawItem?.changes)
      ? rawItem.changes
        .map((change) => {
          if (!change || typeof change !== "object") return null;
          const entry = change as { kind?: unknown; path?: unknown };
          const path = String(entry.path ?? "").trim();
          if (!path) return null;
          return { kind: String(entry.kind ?? "modify"), path };
        })
        .filter((entry): entry is { kind: string; path: string } => entry !== null)
      : [];
    const identity = `${jobId}:${itemId || "file-change"}`;
    return {
      type: "file_change",
      title,
      changes,
      status: eventType === "item.completed" ? "completed" : "running",
      identity,
      id: itemId || identity,
      jobId,
      timestamp: event.timestamp,
      phase: event.phase,
      ...(reviewer ? {} : { raw: event.raw }),
    };
  }

  if (!reviewer && (event.phase === "context" || event.phase === "tool" || event.phase === "connection")) {
    return {
      type: "action_step",
      title,
      detail: event.detail,
      status: eventType === "item.completed" ? "completed" : "running",
      jobId,
      timestamp: event.timestamp,
      phase: event.phase,
    };
  }

  if (event.phase !== "command") {
    return {};
  }

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
  const status = rawStatus === "failed" || rawStatus === "declined" || rawStatus === "completed"
    ? (rawStatus === "declined" ? "failed" : rawStatus)
    : (event.raw && typeof event.raw === "object" && "type" in event.raw && event.raw.type === "item.completed")
      ? "completed"
      : "running";
  const identity = `${jobId}:${itemId || command}`;

  const payload: Record<string, unknown> = {
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
  };
  if (!reviewer) payload.raw = event.raw;
  return payload;
}

function resolveImplementationDiffBase(repoPath: string): "origin/dev" | "dev" {
  return hasGitRemoteOrigin(repoPath) ? "origin/dev" : "dev";
}

function hasCommittedImplementationDiff(repoPath: string): boolean {
  const base = resolveImplementationDiffBase(repoPath);
  const result = spawnSync("git", ["diff", "--name-only", `${base}...HEAD`], {
    cwd: repoPath,
    encoding: "utf8",
  });
  return result.status === 0 && Boolean(result.stdout?.trim());
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
  executionMode?: typeof AUTOMATED_ACTION_EXECUTION_MODE,
) => Promise<{ exitCode: number; error?: string }>;

export type ReviewerRunner = (prompt: string, systemPrompt: string) => Promise<string>;

export type ActionsFailureClass = "implementation" | "infrastructure";

export type ActionsFailureOutcome = "rework" | "block-exhausted" | "block-infrastructure";

export interface PullRequestCreationOutcome {
  result: CreatePrResult;
  attempts: number;
}

/**
 * Retries the pull request creation call itself.
 *
 * Verification and detached review already passed by the time this runs, so a
 * `gh` failure says nothing about the code. Re-running the Developer would spend
 * a full agent turn to produce the same diff and fail at the same place, so the
 * retry stays on the CLI call and costs no model tokens.
 */
export function createPullRequestWithRetry(
  create: () => CreatePrResult,
  maxAttempts = PR_CREATION_ATTEMPTS,
): PullRequestCreationOutcome {
  let result = create();
  let attempts = 1;
  while (result.error && attempts < maxAttempts) {
    attempts += 1;
    result = create();
  }
  return { result, attempts };
}

export function classifyActionsFailure(input: {
  failureClass: ActionsFailureClass;
  attemptIndex: number;
  repeated: boolean;
}): ActionsFailureOutcome {
  if (input.failureClass === "infrastructure") return "block-infrastructure";
  if (input.repeated || input.attemptIndex >= MAX_REWORK_ATTEMPTS) return "block-exhausted";
  return "rework";
}

export type BlockedJobResolution = "dismiss";

const BLOCKED_RESOLUTION_OUTCOMES: Record<BlockedJobResolution, { status: ActionJobStatus; summary: string }> = {
  dismiss: { status: "failed", summary: "dismissed by operator" },
};

const DEFAULT_REVIEWER_TIMEOUT_MS = 30 * 60 * 1000;

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
    errors.push(`git rev-parse HEAD returned an invalid commit: ${input.headCommit ?? "<empty>"}`);
  }
  return errors.length > 0 ? errors.join("; ") : undefined;
}

export function parseActionJobIssueSnapshot(job: ActionJobRecord): ActionJobIssueSnapshot {
  try {
    const parsed = JSON.parse(job.issue_snapshot_json) as Partial<ActionJobIssueSnapshot>;
    return {
      title: String(parsed.title ?? job.issue_title),
      description: String(parsed.description ?? job.issue_title),
      acceptanceCriteria: Array.isArray(parsed.acceptanceCriteria)
        ? parsed.acceptanceCriteria.filter((value): value is string => typeof value === "string")
        : [],
      adrs: Array.isArray(parsed.adrs)
        ? parsed.adrs.filter((adr): adr is { id: string; title: string; decision: string } => (
            Boolean(adr)
            && typeof adr.id === "string"
            && typeof adr.title === "string"
            && typeof adr.decision === "string"
          ))
        : [],
    };
  } catch {
    return {
      title: job.issue_title,
      description: job.issue_title,
      acceptanceCriteria: [],
      adrs: [],
    };
  }
}

async function raceReviewerAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Reviewer execution aborted");
  }
  let onAbort: (() => void) | null = null;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("Reviewer execution aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

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
  reviewerTimeoutMs?: number;
  reviewerToolTurnBudget?: number;
  reviewerComplete?: typeof completeNativeChat;
  reviewerModelResolver?: (modelId: string, owner: string) => NativeModelConfig;
  runtimePreflight?: (input: {
    backend?: AgentRuntimeBackend;
    userId: number;
    workspaceRoot: string;
    authUserId?: string;
    requireDurableState: boolean;
    requireProviderResume: boolean;
  }) => ReturnType<typeof checkActionsRuntimePreflight> | Promise<ReturnType<typeof checkActionsRuntimePreflight>>;
  hasRemoteOrigin?: (repoPath: string) => boolean;
  pullRequestCreator?: (options: {
    cwd: string;
    issueId?: number | null;
    title: string;
    body?: string;
    labels?: string[];
    baseBranch?: string;
    branch?: string;
  }) => CreatePrResult;
  mergePipeline?: (options: {
    cwd: string;
    prNumber?: number | null;
    issueId?: number | null;
    branch: string;
    baseBranch?: string;
    expectedHead?: string;
  }) => MergeResult;
  pullRequestStateReader?: (options: { cwd: string; prNumber: number }) => PullRequestStateResult;
}

export class LaneDispatchBus {
  private processingProjects = new Set<string>();
  private activeAbortControllers = new Map<string, AbortController>();
  private developerProjects = new Set<string>();
  private activeDeliveryHeads = new Map<string, string>();

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
    input: {
      stage: string;
      feedback: string;
      reworkCount?: number;
      failureClass?: ActionsFailureClass;
    },
  ): { status: ActionJobStatus; reworkCount: number } {
    const job = getActionJobById(this.db, jobId);
    if (!job) return { status: "failed", reworkCount: 0 };

    const currentCount = Math.max(0, Math.floor(input.reworkCount ?? job.rework_count ?? 0));
    const failure = `${input.stage} failed: ${input.feedback}`;
    const attemptIndex = currentCount + 1;
    const attempts = parseActionJobAttempts(job.attempts_json);
    // The attempt about to be recorded is not in the list yet, so the entry
    // before it is the current last one.
    const previous = attempts.length >= 1 ? attempts[attempts.length - 1] : null;
    const repeated = previous !== null && previous.failure === failure;
    const outcome = classifyActionsFailure({
      failureClass: input.failureClass ?? "implementation",
      attemptIndex,
      repeated,
    });

    // A missing runtime is not something another developer attempt can change.
    // Block without touching attempts_json so the attempt ledger keeps matching
    // the rework budget the job actually spent.
    if (outcome === "block-infrastructure") {
      const reason = `${failure} The environment must be fixed before this job can continue; no rework attempt was spent.`;
      this.updateJobStatus(job.id, "blocked", {
        current_step: reason,
        error_message: failure,
        blocked_at: Date.now(),
      });
      this.recordActionMessage(job, repoPath, formatActionBlockedCard({
        job,
        classification: "infrastructure",
        failureStage: input.stage,
        failure,
        guidanceNote: "The environment must be fixed before this job can continue; no rework attempt was spent.",
      }), "action_blocked", "assistant");
      return { status: "blocked", reworkCount: currentCount };
    }

    const attempt = { attempt: attemptIndex, stage: input.stage, failure, ts: Date.now() };
    attempts.push(attempt);
    const attemptsJson = JSON.stringify(attempts);
    const history = formatAttemptHistory(attempts);
    // The attempt reaches the lane as soon as it is recorded, so a job that is
    // still retrying already explains itself in the conversation.
    this.recordActionMessage(job, repoPath, formatAttemptLine(attempt), "action_attempt_failed", "assistant");

    if (outcome === "block-exhausted") {
      const reason = repeated
        ? `Attempt ${attemptIndex} repeated the failure of attempt ${previous.attempt} unchanged, so the retry was cut short.`
        : `Human attention required after ${MAX_REWORK_ATTEMPTS} rework attempts.`;
      this.updateJobStatus(job.id, "blocked", {
        rework_count: attemptIndex,
        current_step: reason,
        attempts_json: attemptsJson,
        error_message: failure,
        blocked_at: Date.now(),
      });
      this.recordActionMessage(job, repoPath, formatActionBlockedCard({
        job,
        classification: "rework-exhausted",
        failureStage: input.stage,
        failure,
        attempts,
        guidanceNote: reason,
      }), "action_blocked", "assistant");
      return { status: "blocked", reworkCount: attemptIndex };
    }

    const nextCount = attemptIndex;
    const feedback = [
      "Previous attempt failures:",
      history,
      "Fix every recorded root cause, preserve the current feature branch, and rerun verification.",
    ].join("\n");
    const statusMessage = `Actions rework ${nextCount}/${MAX_REWORK_ATTEMPTS} started after ${input.stage} failure.`;
    this.updateJobStatus(job.id, "running", {
      rework_count: nextCount,
      current_step: statusMessage,
      attempts_json: attemptsJson,
      error_message: failure,
    });
    this.recordActionMessage(job, repoPath, statusMessage, "action_rework", "assistant");
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
    updates?: Partial<Pick<ActionJobRecord, "current_step" | "steps_json" | "review_verdicts_json" | "attempts_json" | "pr_number" | "pr_url" | "error_message" | "branch" | "base_sha" | "rework_count" | "blocked_at">>,
  ): ActionJobRecord | null {
    const current = getActionJobById(this.db, jobId);
    const nextUpdates = { ...(updates ?? {}) };
    const nextStep = String(nextUpdates.current_step ?? "").trim();
    if (current && nextStep && nextStep !== current.current_step) {
      const steps = parseActionJobSteps(current.steps_json);
      steps.push({ status, step: nextStep, ts: Date.now() });
      nextUpdates.steps_json = JSON.stringify(steps);
    }
    updateActionJobStatus(this.db, jobId, status, nextUpdates);
    const updated = getActionJobById(this.db, jobId);
    if (updated && this.options.broadcastToActionsLane) {
      const historyKey = this.laneIdentityForJob(updated).historyKey;
      this.options.broadcastToActionsLane({
        type: "action_job_updated",
        jobId: updated.id,
        issueId: updated.issue_id,
        status: updated.status,
        currentStep: updated.current_step,
        steps: parseActionJobSteps(updated.steps_json),
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
    issueDescription?: string;
    acceptanceCriteria?: string[];
    adrs?: Array<{ id: string; title: string; decision: string }>;
    jobKind?: ActionJobKind;
    developerProfileId?: string | null;
    reviewerProfileIds?: string[];
    repoPath?: string;
    authUserId?: string;
  }): { ok: boolean; jobId: string; status: ActionJobStatus } {
    const jobKind = params.jobKind ?? (params.issueId ? "github_issue" : "local_prompt");
    if (
      (jobKind === "github_issue"
        && (!params.issueDescription?.trim()
          || !params.acceptanceCriteria?.length
          || params.acceptanceCriteria.some((criterion) => !criterion.trim())))
      || (jobKind === "local_prompt" && !params.issueDescription?.trim())
    ) {
      throw new Error("Action jobs require a complete issueDescription; GitHub Issue jobs also require non-empty acceptanceCriteria");
    }
    const id = generateJobId(params.issueId);
    const branch = params.issueId ? `codex/issue-${params.issueId}` : `codex/${id}`;
    const projectId = resolveCanonicalProjectId(params.projectId, params.repoPath);
    const laneIdentity = resolveActionsLaneIdentity(this.db, {
      projectId,
      repoPath: params.repoPath,
      authUserId: params.authUserId,
    });
    const issueSnapshot: ActionJobIssueSnapshot = {
      title: params.issueTitle,
      description: params.issueDescription ?? params.issueTitle,
      acceptanceCriteria: [...(params.acceptanceCriteria ?? [])],
      adrs: (params.adrs ?? []).map((adr) => ({ ...adr })),
    };

    const job = createActionJob(this.db, {
      id,
      project_id: projectId,
      job_kind: jobKind,
      issue_id: params.issueId,
      issue_title: params.issueTitle,
      issue_snapshot: issueSnapshot,
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

    this.triggerAutoStart(projectId, params.repoPath, params.authUserId);

    return {
      ok: true,
      jobId: job.id,
      status: job.status,
    };
  }

  private triggerAutoStart(projectId: string, repoPath?: string, authUserId?: string): void {
    const workspaceRoot = String(repoPath ?? "").trim();
    if (!workspaceRoot) {
      console.warn(`[actions] queued job for project '${projectId}' was not auto-started: no repoPath resolved`);
      return;
    }
    queueMicrotask(() => {
      void this.evaluateQueue(projectId, workspaceRoot, authUserId).catch((error) => {
        console.warn(`[actions] auto-start evaluation failed for project '${projectId}':`, error);
      });
    });
  }

  /**
   * Converges job records onto the pull request state GitHub reports. The pass
   * only reads, and converges a job only when the pull request landed on the
   * expected base branch: converging on any other base would release the queue
   * onto a baseline without the change.
   */
  public reconcileJobsWithGitHub(projectId: string, repoPath: string): ActionJobRecord[] {
    const canonicalProjectId = resolveCanonicalProjectId(projectId, repoPath);
    migrateLegacyProjectJobs(this.db, canonicalProjectId, [projectId, repoPath]);
    const jobs = this.db.prepare(
      `SELECT * FROM action_jobs
       WHERE project_id = ? AND pr_number IS NOT NULL
         AND status IN ('queued', 'running', 'verifying', 'reviewing', 'waiting_merge', 'blocked')
       ORDER BY created_at ASC`,
    ).all(canonicalProjectId) as ActionJobRecord[];

    const reader = this.options.pullRequestStateReader ?? readPullRequestState;
    const converged: ActionJobRecord[] = [];

    for (const job of jobs) {
      const prState = reader({ cwd: repoPath, prNumber: job.pr_number as number });
      if (prState.error || !prState.merged) continue;

      if (prState.baseRefName === ACTIONS_BASE_BRANCH) {
        const updated = this.updateJobStatus(job.id, "completed", {
          current_step: `Reconciled with GitHub: PR #${job.pr_number} is merged into ${ACTIONS_BASE_BRANCH}.`,
          error_message: null,
          blocked_at: null,
        });
        if (updated) converged.push(updated);
      } else {
        const mismatch = `PR #${job.pr_number} merged into '${prState.baseRefName ?? "unknown"}' instead of '${ACTIONS_BASE_BRANCH}'.`;
        this.updateJobStatus(job.id, job.status, {
          current_step: `Reconcile: ${mismatch}`,
          error_message: mismatch,
        });
      }
    }

    return converged;
  }

  public async evaluateQueue(projectId: string, repoPath: string, authUserId?: string): Promise<GateCheckResult & { dequeuedJobId?: string }> {
    const canonicalProjectId = resolveCanonicalProjectId(projectId, repoPath);
    migrateLegacyProjectJobs(this.db, canonicalProjectId, [projectId, repoPath]);
    const queueKey = `${canonicalProjectId}:${String(authUserId ?? "").trim() || "*"}`;

    if (this.processingProjects.has(queueKey) || this.developerProjects.has(canonicalProjectId)) {
      return { allowed: false, reason: "Queue is already being evaluated" };
    }

    this.processingProjects.add(queueKey);
    try {
      this.reconcileJobsWithGitHub(canonicalProjectId, repoPath);

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
      const supervised = Boolean(this.options.sessionManager && !this.options.developerRunner);
      const gateResult = checkThreePointGate(this.db, repoPath, canonicalProjectId, "dev", supervised);

      if (!gateResult.allowed) {
        if (gateResult.gateBlocked === "cleanliness") {
          this.updateJobStatus(nextJob.id, "queued", {
            current_step: "Queued — waiting for a clean dev workspace",
            error_message: gateResult.reason,
          });
        }
        return gateResult;
      }

      const preflightInput = {
        backend: this.options.sessionManager?.getRuntimeBackend?.(),
        ...this.laneIdentityForJob(nextJob, repoPath),
        workspaceRoot: repoPath,
        requireDurableState: true,
        requireProviderResume: false,
      };
      let preflight;
      try {
        preflight = await (this.options.runtimePreflight ?? ((input) => {
          const runtime = this.options.sessionManager?.getActionsRuntimePreflight?.({
            userId: input.userId,
            workspaceRoot: input.workspaceRoot,
            authUserId: input.authUserId,
          });
          return checkActionsRuntimePreflight({
            backend: runtime?.backend ?? input.backend,
            capabilities: runtime?.capabilities,
            requireDurableState: input.requireDurableState,
            requireProviderResume: input.requireProviderResume,
          });
        }))(preflightInput);
      } catch (error) {
        preflight = {
          ok: false,
          backend: preflightInput.backend ?? resolveAgentRuntime(),
          missingCapabilities: [],
          unsupportedRuntimeCapabilities: [],
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      if (!preflight.ok) {
        const reason = `Actions runtime preflight failed: ${preflight.reason ?? "unsupported capabilities"}`;
        this.updateJobStatus(nextJob.id, "queued", {
          current_step: "Queued — Actions runtime preflight failed",
          error_message: reason,
        });
        this.recordActionMessage(nextJob, repoPath, reason, "action_preflight_failed", "assistant");
        return {
          allowed: false,
          reason,
        };
      }

      // Gate passed: checkout feature branch and mark running
      let createdAnchor: string | null = null;
      if (supervised) {
        const anchor = spawnSync("git", ["rev-parse", "dev"], { cwd: repoPath, encoding: "utf8" });
        createdAnchor = anchor.status === 0 ? anchor.stdout.trim() : null;
      }
      if (nextJob.branch && !supervised) {
        let checkoutOk = false;
        const branchCheck = spawnSync("git", ["checkout", "-b", nextJob.branch], {
          cwd: repoPath,
          encoding: "utf8",
        });
        if (branchCheck.status === 0) {
          checkoutOk = true;
          const anchor = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoPath, encoding: "utf8" });
          createdAnchor = anchor.status === 0 ? anchor.stdout?.trim() || null : null;
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
          const checkoutFailure = `Failed to checkout feature branch '${nextJob.branch}'. Current branch is '${currentBranch}'.`;
          this.updateJobStatus(nextJob.id, "failed", {
            current_step: "Feature branch checkout failed",
            error_message: checkoutFailure,
          });
          this.recordActionMessage(nextJob, repoPath, `Actions job failed: ${checkoutFailure}`, "action_failed", "assistant");
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
        // A rework pass checks out an existing branch and must keep the anchor
        // recorded when the branch was first cut.
        ...(createdAnchor && !nextJob.base_sha ? { base_sha: createdAnchor } : {}),
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
      const runnerRes = await this.options.developerRunner(
        job,
        repoPath,
        options.reworkFeedback,
        AUTOMATED_ACTION_EXECUTION_MODE,
      );
      if (runnerRes.exitCode !== 0) {
        this.scheduleRework(jobId, repoPath, {
          stage: "Developer execution",
          feedback: runnerRes.error || `Developer runner exited with code ${runnerRes.exitCode}`,
          reworkCount,
        });
        return;
      }
      if (!hasCommittedImplementationDiff(repoPath)) {
        this.scheduleRework(jobId, repoPath, {
          stage: "Developer implementation",
          feedback: "Developer produced no implementation diff",
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

    const finalTaskPrompt = [
      taskPrompt,
      JSON.stringify(parseActionJobIssueSnapshot(job)),
      AUTOMATED_ACTION_INSTRUCTIONS,
      "You own the whole job. Inspect the checkout first; safely prepare the assigned feature branch from dev. Preserve unrelated changes: never reset, clean, stash, or overwrite them. Never develop on dev/main/master. Handle routine environment problems yourself.",
      "After committing, call review_action to invoke your isolated Reviewer subagent. Findings and operational errors return to you. Fix them and call again if needed (at most 3 calls). After PASS, call deliver_action (at most 3 calls). Repair delivery errors yourself; changing code or the base requires fresh review. Never merge outside deliver_action. After successful delivery stop all tools and report completion. If you cannot finish safely, explain the blocker; blocked jobs still offer dismiss only.",
      options.reworkFeedback
        ? `CRITICAL - REWORK INSTRUCTIONS:\n${options.reworkFeedback}\nAddress the failure, re-run tests, and commit the fixes on the same feature branch.`
        : "",
    ].filter(Boolean).join("\n\n");

    if (this.options.sessionManager) {
      const sessionManager = this.options.sessionManager;
      const workspaceRoot = repoPath;
      const projectId = job.project_id;
      const identity = this.laneIdentityForJob(job, repoPath);
      const { authUserId, userId, historyKey } = identity;
      const abortCtrl = new AbortController();
      this.activeAbortControllers.set(jobId, abortCtrl);
      this.developerProjects.add(projectId);

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
      const detach = () => { unsubscribe?.(); unsubscribe = null; };
      try {
        const execute = async () => {
          const orchestrator = sessionManager.getOrCreate(userId, repoPath, true, {
            authUserId,
            projectId,
          });

          // Fresh job threads register job tools even after a runtime upgrade.
          orchestrator.reset?.();

          // Inject developer instructions from database profile
          if (typeof orchestrator.setDeveloperInstructions === "function") {
            orchestrator.setDeveloperInstructions(systemPrompt);
          }

          // Attach event listener for real-time WebSocket streaming
          unsubscribe = orchestrator.onEvent((event: AgentEvent) => {
            const payload = buildActionAgentEventPayload(event, job.id);
            if (Object.keys(payload).length === 0) return;
            if (this.options.broadcastToActionsLane) {
              this.options.broadcastToActionsLane(
                payload,
                historyKey,
                projectId,
              );
            }
            if (this.options.historyStore && payload.type === "command" && isTerminalCommandPayload(payload)) {
              this.options.historyStore.add(historyKey, {
                role: "status",
                text: buildExecuteHistoryText(String(payload.command ?? ""), String(payload.output ?? "")),
                ts: Date.now(),
                kind: ACTION_EXECUTE_HISTORY_KIND,
              });
            }
            if (this.options.historyStore && payload.type === "file_change" && payload.status === "completed") {
              const changes = Array.isArray(payload.changes) ? payload.changes : [];
              const text = changes
                .map((change) => {
                  const entry = change && typeof change === "object" ? change as { kind?: unknown; path?: unknown } : {};
                  return `[${String(entry.kind ?? "modify")}] ${String(entry.path ?? "")}`.trim();
                })
                .filter(Boolean)
                .join("\n");
              if (text) {
                this.options.historyStore.add(historyKey, {
                  role: "status",
                  text: `[Files]\n${text}`,
                  ts: Date.now(),
                  kind: "file_change",
                });
              }
            }
          });

          const actionTools = this.superviseJob(job, repoPath, abortCtrl.signal);
          const run = async () => {
            try {
              return await runAgentTurn(orchestrator, finalTaskPrompt, {
                streaming: true,
                signal: abortCtrl.signal,
                cwd: repoPath,
                workspaceRoot,
                historySessionId: historyKey,
                authUserId: job.auth_user_id ?? undefined,
                actionTools,
              });
            } finally {
              await actionTools.dispose();
            }
          };
          const turnResult = await run();
          abortCtrl.signal.throwIfAborted();

          detach();
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

          if (getActionJobById(this.db, jobId)?.status !== "completed") {
            this.activeAbortControllers.delete(jobId);
            this.scheduleRework(jobId, repoPath, {
              stage: "Developer supervision",
              feedback: "Developer ended without reviewed delivery. " + turnResult.response.slice(-1500),
              reworkCount,
              failureClass: "infrastructure",
            });
            return;
          }

        };
        const lock = this.options.getWorkspaceLock?.(repoPath);
        if (lock) await lock.runExclusive(execute, abortCtrl.signal);
        else await execute();
      } catch (err) {
        if (getActionJobById(this.db, jobId)?.status === "completed") return;
        detach();
        this.activeAbortControllers.delete(jobId);

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
            failureClass: "infrastructure",
          });
        }
      } finally {
        detach();
        this.activeAbortControllers.delete(jobId);
        this.developerProjects.delete(projectId);
        if (getActionJobById(this.db, jobId)?.status === "completed") {
          queueMicrotask(() => { void this.evaluateQueue(job.project_id, repoPath, job.auth_user_id ?? undefined); });
        }
      }
      return;
    }

    // In automated test harness without runner override or sessionManager, avoid unneeded execution
    if (process.env.ADS_TEST_STATE_ROOT && !this.options.sessionManager && !this.options.developerRunner) {
      return;
    }

    if (!this.options.sessionManager && !this.options.developerRunner) {
      this.scheduleRework(jobId, repoPath, {
        stage: "Developer execution",
        feedback: "No Actions session manager configured for task execution",
        reworkCount,
        failureClass: "infrastructure",
      });
      return;
    }

    if (process.env.ADS_TEST_STATE_ROOT) {
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
      failureClass: "infrastructure",
    });
  }

  private superviseJob(job: ActionJobRecord, repoPath: string, signal: AbortSignal): ReturnType<typeof createActionSupervision> {
    const git = (...args: string[]): string => {
      signal.throwIfAborted();
      const result = spawnSync("git", args, { cwd: repoPath, encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr?.trim() || "Git evidence unavailable.");
      return result.stdout.trim();
    };
    let deliveryHead = "";
    const snapshot = () => {
      const current = getActionJobById(this.db, job.id);
      if (!current || !["running", "verifying", "reviewing", "waiting_merge"].includes(current.status)) {
        throw new Error("This Actions job is no longer active.");
      }
      if (git("branch", "--show-current") !== job.branch) throw new Error(`Prepare the assigned feature branch '${job.branch}' first.`);
      if (git("status", "--porcelain", "-uno")) throw new Error("Commit tracked changes before requesting review or delivery.");
      return `${git("rev-parse", resolveImplementationDiffBase(repoPath))}:${git("rev-parse", "HEAD")}`;
    };
    return createActionSupervision({
      signal, snapshot,
      assertDeliveryTarget: (approved) => {
        deliveryHead = approved.split(":")[1]!;
        try { if (snapshot() === approved) return; } catch { /* A merged PR may already have cleaned its branch. */ }
        signal.throwIfAborted();
        if (git("status", "--porcelain", "-uno")) throw new Error("Preserve unrelated working changes before delivery cleanup.");
        const current = getActionJobById(this.db, job.id);
        if (current?.pr_number) {
          const state = this.options.pullRequestStateReader?.({ cwd: repoPath, prNumber: current.pr_number })
            ?? readPullRequestState({ cwd: repoPath, prNumber: current.pr_number, includeHead: true });
          if (state.merged && state.state === "MERGED" && state.baseRefName === ACTIONS_BASE_BRANCH && state.headRefOid === deliveryHead) return;
        }
        throw new Error("Delivery target changed. Call review_action again.");
      },
      review: async (childSignal) => {
        this.updateJobStatus(job.id, "running");
        try {
          const verdict = await this.runJobCycle(job.id, repoPath, { reviewOnly: true, signal: childSignal });
          if (!verdict) throw new Error("Reviewer did not return a verdict.");
          return verdict;
        } finally {
          if (!childSignal.aborted && ["running", "verifying", "reviewing"].includes(getActionJobById(this.db, job.id)?.status ?? "")) {
            this.updateJobStatus(job.id, "running", { current_step: "Reviewer returned control to Developer" });
          }
        }
      },
      deliver: () => {
        this.activeDeliveryHeads.set(job.id, deliveryHead);
        try {
          const result = this.handleReviewResult({ jobId: job.id, repoPath, verdict: "PASS", reviewSummary: "Approved by supervised Reviewer", supervised: true, expectedHead: deliveryHead });
          return { ok: result.status === "completed", ...result };
        } finally { this.activeDeliveryHeads.delete(job.id); }
      },
    });
  }

  public async executeReviewer(
    payload: ReviewPayload,
    repoPath: string,
    reviewerProfileId?: string,
    _historyKey?: string,
    _projectId?: string,
    jobId?: string,
    signal?: AbortSignal,
  ): Promise<ReviewVerdict> {
    if (payload.diffCaptureError) {
      throw new ReviewerIncompleteError("Reviewer evidence capture failed; no authoritative verdict is available.");
    }
    const profile = reviewerProfileId ? getRoleProfileById(this.db, reviewerProfileId) : getDefaultRoleProfile(this.db, "reviewer");
    if (!profile || profile.role !== "reviewer" || !profile.is_enabled || !profile.model_id.trim() || !profile.system_prompt.trim()) {
      throw new Error("Reviewer execution failed: configure an enabled Reviewer role profile with a model and system prompt.");
    }
    const controller = new AbortController();
    const timeoutMs = this.options.reviewerTimeoutMs ?? DEFAULT_REVIEWER_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(new Error("Reviewer execution timed out.")), timeoutMs);
    const reviewerSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      reviewerSignal.throwIfAborted();
      const prompt = buildReviewPrompt(payload);
      if (this.options.reviewerRunner) {
        return await raceReviewerAbort(runDetachedReview(payload, {
          callModel: this.options.reviewerRunner, systemPrompt: profile.system_prompt, reviewerProfileId: profile.id,
        }), reviewerSignal);
      }
      const commit = payload.diffRange?.headCommit;
      if (!commit) throw new Error("Reviewer inspection requires captured head commit evidence.");
      const owner = (jobId ? getActionJobById(this.db, jobId)?.auth_user_id : null) ?? "";
      const model = this.options.reviewerModelResolver
        ? this.options.reviewerModelResolver(profile.model_id, owner)
        : createNativeModelResolver({ owner, stateDbPath: this.db.name, requireOwnerCredentials: true }).resolve(profile.model_id);
      const result = await runReviewerInspection({
        workspace: repoPath, commit, prompt, systemPrompt: profile.system_prompt,
        model: { ...model, options: { ...model.options, reasoningEffort: profile.reasoning_effort } },
        profileId: profile.id, signal: reviewerSignal,
        toolTurnBudget: this.options.reviewerToolTurnBudget ?? (process.env.ADS_REVIEWER_TOOL_TURNS === "0" ? 0 : undefined),
        diff: payload.diff,
        complete: this.options.reviewerComplete,
      });
      reviewerSignal.throwIfAborted();
      return result;
    } catch (error) {
      if (error instanceof ReviewerIncompleteError) throw error;
      throw new Error(`Reviewer execution failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  public async runJobCycle(
    jobId: string,
    repoPath: string,
    options: {
      testCommand?: string;
      callReviewerModel?: (prompt: string, sys: string) => Promise<string>;
      reworkCount?: number;
      reviewOnly?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<ReviewVerdict | void> {
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

    const testParts = testCmd.split(" ");
    const testRes = spawnSync(testParts[0]!, testParts.slice(1), {
      cwd: repoPath,
      encoding: "utf8",
    });
    const verificationOutput = [testRes.stdout, testRes.stderr]
      .map((value) => String(value ?? "").trim())
      .filter(Boolean)
      .join("\n")
      .slice(-20_000);

    const testReport = {
      command: testCmd,
      exitCode: testRes.status ?? 1,
      summary: testRes.status === 0
        ? (verificationOutput || "Tests and checks passed successfully")
        : (verificationOutput || "Verification command failed"),
      output: verificationOutput,
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
        text: buildExecuteHistoryText(
          `[Verification exit ${testReport.exitCode}] ${testCmd}`,
          testReport.summary,
        ),
        ts: Date.now(),
        kind: ACTION_EXECUTE_HISTORY_KIND,
      });
    }

    options.signal?.throwIfAborted();
    if (testReport.exitCode !== 0) {
      if (options.reviewOnly) throw new Error(`Verification failed: ${testReport.summary}`);
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

    const diffBase = resolveImplementationDiffBase(repoPath);
    const baseCommitResult = spawnSync("git", ["rev-parse", diffBase], { cwd: repoPath, encoding: "utf8" });
    const headCommitResult = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoPath, encoding: "utf8" });
    const baseCommit = baseCommitResult.stdout?.trim();
    const headCommit = headCommitResult.stdout?.trim();
    const capturedRange = `${baseCommit}...${headCommit}`;
    const diffRes = spawnSync("git", ["diff", capturedRange], {
      cwd: repoPath,
      encoding: "utf8",
    });
    const diffStatRes = spawnSync("git", ["diff", "--stat", capturedRange], {
      cwd: repoPath,
      encoding: "utf8",
    });

    const captureErrors: string[] = [];
    if (diffRes.status !== 0) captureErrors.push(`git diff exited with status ${String(diffRes.status)}`);
    if (diffStatRes.status !== 0) captureErrors.push(`git diff --stat exited with status ${String(diffStatRes.status)}`);
    if (baseCommitResult.status !== 0) {
      captureErrors.push(`git rev-parse ${diffBase} exited with status ${String(baseCommitResult.status)}`);
    }
    if (headCommitResult.status !== 0) captureErrors.push(`git rev-parse HEAD exited with status ${String(headCommitResult.status)}`);
    const diff = diffRes.stdout || "";
    const diffStat = diffStatRes.stdout || "";
    const evidenceError = validateGitEvidence({ diff, diffStat, baseCommit, headCommit });
    const issueSnapshot = parseActionJobIssueSnapshot(job);

    const payload: ReviewPayload = {
      issue: {
        id: job.issue_id,
        title: issueSnapshot.title,
        description: issueSnapshot.description,
        acceptanceCriteria: issueSnapshot.acceptanceCriteria,
      },
      adrs: issueSnapshot.adrs,
      diffRange: {
        baseRef: diffBase,
        headRef: "HEAD",
        baseCommit: baseCommit || undefined,
        headCommit: headCommit || undefined,
        range: `${diffBase}...HEAD`,
      },
      diff,
      diffStat,
      diffCaptureError: [...captureErrors, evidenceError].filter((error): error is string => Boolean(error)).join("; ") || undefined,
      testReport,
      ...(!captureErrors.length && !evidenceError && !filterDiff(diff, REVIEW_DIFF_MAX_LINES, diffStat).truncated
        ? extractRelatedContexts(repoPath, baseCommit!, headCommit!)
        : {}),
    };

    const reviewerProfile = (job.reviewer_profile_ids_json ? JSON.parse(job.reviewer_profile_ids_json)[0] : null)
      ?? getDefaultRoleProfile(this.db, "reviewer");

    let verdict: ReviewVerdict;
    const reviewerAbort = new AbortController();
    if (!options.reviewOnly) this.activeAbortControllers.set(jobId, reviewerAbort);
    const childSignal = options.signal ? AbortSignal.any([options.signal, reviewerAbort.signal]) : reviewerAbort.signal;
    const reviewerTimeoutMs = Math.max(1, this.options.reviewerTimeoutMs ?? DEFAULT_REVIEWER_TIMEOUT_MS);
    const reviewerTimer = setTimeout(() => {
      reviewerAbort.abort(new Error(`Reviewer execution timed out after ${reviewerTimeoutMs}ms`));
    }, reviewerTimeoutMs);
    try {
      if (options.callReviewerModel) {
        const profile = typeof reviewerProfile === "string" ? getRoleProfileById(this.db, reviewerProfile) : reviewerProfile;
        if (!profile || profile.role !== "reviewer" || !profile.is_enabled || !profile.model_id.trim() || !profile.system_prompt.trim()) {
          throw new Error("Reviewer execution failed: configure an enabled Reviewer role profile with a model and system prompt.");
        }
        verdict = await raceReviewerAbort(
          runDetachedReview(payload, {
            callModel: options.callReviewerModel,
            systemPrompt: profile.system_prompt,
            reviewerProfileId: typeof reviewerProfile === "string" ? reviewerProfile : reviewerProfile?.id,
          }),
          childSignal,
        );
      } else {
        verdict = await raceReviewerAbort(
          this.executeReviewer(
            payload,
            repoPath,
            typeof reviewerProfile === "string" ? reviewerProfile : reviewerProfile?.id,
            historyKey,
            projectId,
            job.id,
            childSignal,
          ),
          childSignal,
        );
      }
    } catch (error) {
      if (options.reviewOnly) throw error;
      const currentJob = getActionJobById(this.db, jobId);
      if (reviewerAbort.signal.aborted && currentJob?.status === "cancelled") {
        return;
      }
      this.scheduleRework(jobId, repoPath, {
        stage: "Reviewer execution",
        feedback: error instanceof Error ? error.message : String(error),
        reworkCount: options.reworkCount,
        failureClass: "infrastructure",
      });
      return;
    } finally {
      clearTimeout(reviewerTimer);
      if (this.activeAbortControllers.get(jobId) === reviewerAbort) {
        this.activeAbortControllers.delete(jobId);
      }
    }

    options.signal?.throwIfAborted();
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

    if (options.reviewOnly) return verdict;
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
    supervised?: boolean;
    expectedHead?: string;
  }): { status: ActionJobStatus; prNumber?: number | null; prUrl?: string | null; error?: string } {
    const job = getActionJobById(this.db, params.jobId);
    if (!job) {
      throw new Error(`Job not found: ${params.jobId}`);
    }

    if (params.verdict === "PASS") {
      const hasRemote = this.options.hasRemoteOrigin?.(params.repoPath) ?? hasGitRemoteOrigin(params.repoPath);
      let prNumber: number | null = params.supervised ? job.pr_number : null;
      let prUrl: string | null = params.supervised ? job.pr_url : null;

      if (hasRemote && !prNumber) {
        const { result: prRes, attempts: prAttempts } = createPullRequestWithRetry(() =>
          (this.options.pullRequestCreator ?? createPullRequest)({
            cwd: params.repoPath,
            issueId: job.issue_id,
            title: job.issue_title,
            baseBranch: ACTIONS_BASE_BRANCH,
            branch: job.branch ?? undefined,
            baseSha: job.base_sha,
          }),
        );

        if (prRes.error || !prRes.prNumber) {
          if (params.supervised) return { status: "running", error: prRes.error || "PR creation failed." };
          const rework = this.scheduleRework(job.id, params.repoPath, {
            stage: "PR creation",
            feedback: `${prRes.error || "Unknown error"} (tried ${prAttempts} times)`,
            reworkCount: params.reworkCount ?? job.rework_count,
            failureClass: "infrastructure",
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
          ? `Review passed. PR #${prNumber} created. Starting automatic merge and cleanup.`
          : "Review passed. Starting automatic local merge and cleanup.",
      });

      const projectId = job.project_id;
      const identity = this.laneIdentityForJob(job, params.repoPath);
      const historyKey = identity.historyKey;

      if (this.options.broadcastToActionsLane) {
        this.options.broadcastToActionsLane({
          type: "message",
          role: "status",
          text: hasRemote
            ? `Review approved. PR #${prNumber} created (${prUrl}). Starting automatic merge and cleanup.`
            : "Review approved. Starting automatic local merge and cleanup.",
          jobId: job.id,
          ts: Date.now(),
        }, historyKey, projectId);
      }

      if (this.options.historyStore) {
        this.options.historyStore.add(historyKey, {
          role: "status",
          text: hasRemote
            ? `[PR Created] PR #${prNumber}: ${prUrl}. Starting automatic merge and cleanup.`
            : "[Local Merge] Review approved. Starting automatic merge and cleanup.",
          ts: Date.now(),
          kind: "pr_delivery",
        });
      }

      const mergeResult = this.executeDeterministicMerge(job.id, params.repoPath, params);
      const completedJob = getActionJobById(this.db, job.id);

      return {
        status: completedJob?.status ?? (mergeResult.success ? "completed" : "running"),
        prNumber,
        prUrl,
        ...(mergeResult.error ? { error: mergeResult.error } : {}),
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

  public executeDeterministicMerge(jobId: string, repoPath: string, options: { supervised?: boolean; expectedHead?: string } = {}): { success: boolean; error?: string } {
    const job = getActionJobById(this.db, jobId);
    if (!job) {
      return { success: false, error: `Job not found: ${jobId}` };
    }

    if (this.options.sessionManager && !this.options.developerRunner
      && (!options.expectedHead || this.activeDeliveryHeads.get(jobId) !== options.expectedHead
        || this.activeAbortControllers.get(jobId)?.signal.aborted !== false)) {
      return { success: false, error: "Merge requires live Developer delivery authority for the reviewed commit." };
    }

    const mergeRes = (this.options.mergePipeline ?? mergeAndCleanupPipeline)({
      cwd: repoPath,
      prNumber: job.pr_number,
      issueId: job.issue_id,
      branch: job.branch ?? "",
      expectedHead: options.expectedHead,
    });

    if (mergeRes.success) {
      this.updateJobStatus(job.id, "completed", {
        current_step: "PR squash merged, Issue closed, dev synchronized, and branch cleaned up.",
        error_message: null,
      });

      // After task completes, trigger next queued task evaluation
      if (!options.supervised) queueMicrotask(() => {
        void this.evaluateQueue(job.project_id, repoPath, job.auth_user_id ?? undefined);
      });
    } else {
      if (options.supervised) {
        this.updateJobStatus(job.id, "running", { current_step: "Delivery returned control to Developer", error_message: mergeRes.error });
        return mergeRes;
      }
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
    this.recordActionMessage(
      job,
      targetRepo,
      `Actions job '${job.issue_title}' was cancelled.`,
      "action_cancelled",
      "assistant",
    );
    if (targetRepo) {
      safeResetToDev(targetRepo);
    }
  }

  /**
   * Records an operator decision on a blocked job. Only `blocked` is legal: any
   * other state, including `waiting_merge`, is owned by the deterministic
   * backend pipeline and must not be short-circuited by hand.
   */
  public resolveJob(
    jobId: string,
    action: BlockedJobResolution,
    options: { note?: string; repoPath?: string } = {},
  ): { ok: boolean; status?: ActionJobStatus; error?: string } {
    const job = getActionJobById(this.db, jobId);
    if (!job) return { ok: false, error: `Job not found: ${jobId}` };
    if (job.status !== "blocked") {
      return { ok: false, error: `Job ${jobId} is '${job.status}'; only blocked jobs can be resolved` };
    }

    const note = String(options.note ?? "").trim();
    const targetRepo = options.repoPath || job.project_id;
    const noteSuffix = note ? ` Operator note: ${note}` : "";
    const outcome = BLOCKED_RESOLUTION_OUTCOMES[action];

    this.updateJobStatus(jobId, outcome.status, {
      current_step: `Resolved by operator: ${outcome.summary}.${noteSuffix}`,
      error_message: note || "Dismissed by operator.",
      blocked_at: null,
    });
    this.recordActionMessage(
      job,
      targetRepo,
      `Actions job '${job.issue_title}' was resolved as '${action}'.${noteSuffix}`,
      "action_resolved",
      "assistant",
    );
    queueMicrotask(() => {
      void this.evaluateQueue(job.project_id, targetRepo, job.auth_user_id ?? undefined);
    });
    return { ok: true, status: outcome.status };
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
