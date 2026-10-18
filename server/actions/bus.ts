import { createActionSupervision } from "./supervision.js";
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Database as DatabaseType } from "better-sqlite3";

import { runAgentTurn } from "../agents/turn.js";
import type { ActionTools } from "../agents/actionTools.js";
import type { AgentEvent } from "../codex/events.js";
import type { SessionManager } from "../sessions/sessionManager.js";
import { buildWsConnectionIdentity } from "../web/server/ws/connectionIdentity.js";
import type { AsyncLock } from "../utils/asyncLock.js";
import {
  buildReviewPrompt,
  runDetachedReview,
} from "../reviewer/runner.js";
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
import {
  captureReviewPayloadAsync,
  captureReviewPayload,
  type ReviewTarget,
} from "./reviewService.js";

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
    "- Acopilot will automatically diagnose this handoff and may dispatch a bounded follow-up with fresh independent Review.",
    "- This execution will not resume. For manual cleanup, click **Dismiss** on the top queue stack to clear the blocked record.",
  );
  return lines.join("\n");
}

function buildExecuteHistoryText(command: string, output: string): string {
  const normalizedCommand = String(command ?? "").trim() || "command";
  const normalizedOutput = String(output ?? "").replace(/\r\n/g, "\n").trim();
  return normalizedOutput ? `$ ${normalizedCommand}\n${normalizedOutput}` : `$ ${normalizedCommand}`;
}

function buildActionStepHistoryText(payload: Record<string, unknown>): string {
  const phase = String(payload.phase ?? "").trim();
  const detail = String(payload.detail ?? "").trim() || String(payload.title ?? "").trim();
  const label = phase ? `Developer ${phase}` : "Developer activity";
  return detail ? `[${label}] ${detail}` : `[${label}] Activity`;
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
    const detailOrTitle = String(event.detail ?? event.title ?? "").trim();
    const identity = `${jobId}:${itemId || `${event.phase}:${detailOrTitle || "activity"}`}`;
    return {
      type: "action_step",
      title,
      detail: event.detail,
      status: eventType === "item.completed" ? "completed" : "running",
      identity,
      id: itemId || identity,
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

function resolveAssignedBranchHead(repoPath: string, branch: string | null): string | null {
  if (!branch) return null;
  const currentBranch = spawnSync("git", ["branch", "--show-current"], { cwd: repoPath, encoding: "utf8" });
  if (currentBranch.status !== 0 || currentBranch.stdout?.trim() !== branch) return null;
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: repoPath, encoding: "utf8" });
  if (status.status !== 0 || status.stdout?.trim()) return null;
  const ref = `refs/heads/${branch}`;
  const refCheck = spawnSync("git", ["check-ref-format", ref], { cwd: repoPath, encoding: "utf8" });
  if (refCheck.status !== 0) return null;
  const result = spawnSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd: repoPath, encoding: "utf8" });
  const commit = result.stdout?.trim();
  return result.status === 0 && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(commit ?? "") ? commit! : null;
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
const DEFAULT_INTERACTIVE_VERIFICATION_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_INTERACTIVE_COMMAND_TIMEOUT_MS = 30 * 1000;

export { validateGitEvidence } from "./reviewService.js";

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

function parseCompleteReviewIssueSnapshot(job: ActionJobRecord): ActionJobIssueSnapshot | null {
  try {
    const parsed = JSON.parse(job.issue_snapshot_json) as Partial<ActionJobIssueSnapshot> | null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    if (typeof parsed.title !== "string" || !parsed.title.trim()) return null;
    if (typeof parsed.description !== "string" || !parsed.description.trim()) return null;
    if (!Array.isArray(parsed.acceptanceCriteria)
      || parsed.acceptanceCriteria.some((criterion) => typeof criterion !== "string" || !criterion.trim())) return null;
    if (job.job_kind === "github_issue" && parsed.acceptanceCriteria.length === 0) return null;
    if (!Array.isArray(parsed.adrs) || parsed.adrs.some((adr) => (
      !adr
      || typeof adr.id !== "string"
      || !adr.id.trim()
      || typeof adr.title !== "string"
      || !adr.title.trim()
      || typeof adr.decision !== "string"
      || !adr.decision.trim()
    ))) return null;

    return {
      title: parsed.title,
      description: parsed.description,
      acceptanceCriteria: parsed.acceptanceCriteria as string[],
      adrs: parsed.adrs as ActionJobIssueSnapshot["adrs"],
    };
  } catch {
    return null;
  }
}

function captureActionJobReviewPayload(
  job: ActionJobRecord,
  repoPath: string,
  testReport?: ReviewPayload["testReport"],
  requirePinnedEvidence = false,
): ReviewPayload {
  const issueSnapshot = requirePinnedEvidence
    ? parseCompleteReviewIssueSnapshot(job)
    : parseActionJobIssueSnapshot(job);
  const fallbackSnapshot = issueSnapshot ?? parseActionJobIssueSnapshot(job);
  const target: ReviewTarget = {
    issue: {
      id: job.issue_id,
      title: fallbackSnapshot.title,
      description: fallbackSnapshot.description,
      acceptanceCriteria: fallbackSnapshot.acceptanceCriteria,
    },
    adrs: fallbackSnapshot.adrs,
    baseRef: requirePinnedEvidence ? job.base_sha ?? "<missing-base>" : resolveImplementationDiffBase(repoPath),
    headRef: requirePinnedEvidence ? job.head_sha ?? "<missing-head>" : "HEAD",
    baseCommit: requirePinnedEvidence ? job.base_sha : undefined,
    headCommit: requirePinnedEvidence ? job.head_sha : undefined,
  };
  const payload = captureReviewPayload(target, repoPath, {
    requirePinnedEvidence,
    testReport,
  });
  if (requirePinnedEvidence && !issueSnapshot) {
    payload.diffCaptureError = [
      payload.diffCaptureError,
      "persisted Issue or ADR snapshot is missing or invalid",
    ].filter(Boolean).join("; ");
  }
  return payload;
}

export class ActionJobReviewConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionJobReviewConflictError";
  }
}

export type IndependentReviewResult = Pick<ReviewVerdict, "status" | "summary" | "defects">;

export type InteractiveReviewTarget = ReviewTarget & {
  projectId: string;
  repoPath: string;
  authUserId: string;
  branch: string;
  prNumber: number;
  prUrl: string;
};

export type InteractiveReviewTargetRequest = {
  projectId: string;
  repoPath: string;
  authUserId: string;
  branch?: string;
  prNumber?: number | null;
  reviewPrompt?: string;
};

type InteractiveWorkspaceReviewTarget = ReviewTarget & {
  projectId: string;
  repoPath: string;
  authUserId: string;
  branch: string;
  workingTreeDiff: {
    diff: string;
    diffStat: string;
    range: string;
  };
};

type InteractiveReviewSession = {
  projectId: string;
  repoPath: string;
  authUserId: string;
  target: InteractiveReviewTarget | InteractiveWorkspaceReviewTarget;
  key: string;
  deliveryTarget?: InteractiveReviewTarget;
  requirePinnedEvidence: boolean;
  diffOverride?: InteractiveWorkspaceReviewTarget["workingTreeDiff"];
};

type InteractiveGithubMetadata = {
  pullRequest: {
    number: number;
    url: string;
    state: string;
    headRefName: string;
    baseRefName: string;
    baseRefOid: string;
    headRefOid: string;
  };
  issue: {
    number: number;
    title: string;
    body: string;
  };
};

type InteractiveCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

function normalizeInteractiveTimeout(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value!)) : fallback;
}

function parseAcceptanceCriteria(body: string): string[] {
  const section = /(?:^|\n)##+\s+Acceptance Criteria\s*\n([\s\S]*?)(?=\n##+\s|$)/i.exec(body)?.[1] ?? "";
  return section
    .split(/\r?\n/)
    .map((line) => /^\s*(?:[-*]|\d+[.)])\s+(.+?)\s*$/.exec(line)?.[1]?.trim() ?? "")
    .filter(Boolean);
}

function interactiveTargetKey(target: InteractiveReviewTarget): string {
  return createHash("sha256")
    .update(JSON.stringify({
      repoPath: target.repoPath,
      authUserId: target.authUserId,
      branch: target.branch,
      prNumber: target.prNumber,
      prUrl: target.prUrl,
      issue: target.issue,
      adrs: target.adrs ?? [],
      baseRef: target.baseRef,
      headRef: target.headRef,
      baseCommit: target.baseCommit,
      headCommit: target.headCommit,
    }))
    .digest("hex");
}

function interactiveWorkspaceTargetKey(target: InteractiveWorkspaceReviewTarget): string {
  return createHash("sha256")
    .update(JSON.stringify({
      repoPath: target.repoPath,
      authUserId: target.authUserId,
      branch: target.branch,
      issue: target.issue,
      adrs: target.adrs ?? [],
      baseRef: target.baseRef,
      headRef: target.headRef,
      baseCommit: target.baseCommit,
      headCommit: target.headCommit,
      workingTreeDiff: target.workingTreeDiff,
    }))
    .digest("hex");
}

function findVerificationReport(
  job: ActionJobRecord,
  history: Array<{ role: string; text: string; ts: number; kind?: string }>,
): ReviewPayload["testReport"] {
  const steps = parseActionJobSteps(job.steps_json);
  let verificationIndex = -1;
  for (let index = 0; index < steps.length; index += 1) {
    if (steps[index]?.status === "verifying") verificationIndex = index;
  }
  if (verificationIndex < 0) return undefined;

  const verificationStep = steps[verificationIndex]!;
  const nextStepAt = steps[verificationIndex + 1]?.ts ?? job.updated_at;
  const entry = [...history].reverse().find((item) => (
    item.kind === ACTION_EXECUTE_HISTORY_KIND
    && item.ts >= verificationStep.ts
    && item.ts <= nextStepAt
    && /^\$ \[Verification exit \d+\] /.test(item.text)
  ));
  if (!entry) return undefined;

  const match = /^\$ \[Verification exit (-?\d+)\] ([^\n]+)(?:\r?\n([\s\S]*))?$/.exec(entry.text);
  if (!match) return undefined;
  const output = String(match[3] ?? "").trim();
  const exitCode = Number(match[1]);
  return {
    command: match[2]!.trim(),
    exitCode,
    summary: output || (exitCode === 0 ? "Tests and checks passed successfully" : "Verification command failed"),
    output,
  };
}

function formatReviewVerdictCard(verdict: Pick<ReviewVerdict, "status" | "summary" | "defects">): string {
  const defectsList = verdict.defects.length > 0
    ? "\n\n**Defects Identified:**\n" + verdict.defects.map((defect) => (
        `- [${defect.severity.toUpperCase()}] \`${defect.file}${defect.line ? `:${defect.line}` : ""}\`: ${defect.description}`
      )).join("\n")
    : "\n\n*No blocking defects identified.*";
  return `### Code Review: ${verdict.status === "PASS" ? "✅ Approved (PASS)" : "❌ Rejected (REJECT)"}\n\n${verdict.summary}${defectsList}`;
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
  captureActionsLaneGeneration?: (logicalHistoryKey: string) => number;
  captureLaneGeneration?: (namespace: string, logicalHistoryKey: string) => number;
  broadcastToActionsLane?: (payload: unknown, logicalHistoryKey: string, projectId: string, laneGeneration: number) => void;
  interruptControllers?: Map<string, AbortController>;
  developerRunner?: DeveloperRunner;
  reviewerRunner?: ReviewerRunner;
  testCommand?: string;
  interactiveCommandTimeoutMs?: number;
  interactiveVerificationTimeoutMs?: number;
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
    expectedBaseSha?: string;
  }) => MergeResult;
  pullRequestStateReader?: (options: { cwd: string; prNumber: number }) => PullRequestStateResult;
  interactiveGithubMetadataReader?: (input: {
    repoPath: string;
    branch: string;
    issueId: number;
    prNumber?: number | null;
  }) => InteractiveGithubMetadata | Promise<InteractiveGithubMetadata>;
}

export class LaneDispatchBus {
  private processingProjects = new Set<string>();
  private activeAbortControllers = new Map<string, AbortController>();
  private developerProjects = new Map<string, string>();
  private activeDeliveryHeads = new Map<string, string>();
  private independentReviewerJobs = new Set<string>();
  private interactiveReviewerTargets = new Set<string>();
  private readonly developerSessionJobs = new Map<string, string>();

  constructor(
    private db: DatabaseType,
    private options: LaneDispatchBusOptions = {},
  ) {}

  private laneIdentityForJob(job: ActionJobRecord, repoPath?: string) {
    if (job.auth_user_id && job.chat_session_id) {
      const identityArgs = {
        authUserId: job.auth_user_id,
        sessionId: job.project_id,
        chatSessionId: job.chat_session_id,
        connectionId: "actions",
      };
      return {
        ...buildWsConnectionIdentity({ ...identityArgs, generation: job.lane_generation }),
        logicalHistoryKey: buildWsConnectionIdentity(identityArgs).historyKey,
      };
    }

    const identity = resolveActionsLaneIdentity(this.db, {
      projectId: job.project_id,
      repoPath,
      authUserId: job.auth_user_id,
      generation: job.lane_generation,
    });
    if (identity) return identity;

    const identityArgs = {
      authUserId: `actions:${job.id}`,
      sessionId: job.project_id,
      chatSessionId: job.chat_session_id || "main",
      connectionId: "actions",
    };
    return {
      ...buildWsConnectionIdentity({ ...identityArgs, generation: job.lane_generation }),
      logicalHistoryKey: buildWsConnectionIdentity(identityArgs).historyKey,
    };
  }

  private broadcastJobEvent(job: ActionJobRecord, payload: unknown, repoPath?: string): void {
    const identity = this.laneIdentityForJob(job, repoPath);
    this.options.broadcastToActionsLane?.(
      payload,
      identity.logicalHistoryKey,
      job.project_id,
      job.lane_generation,
    );
  }

  private recordActionMessage(
    job: ActionJobRecord,
    repoPath: string,
    text: string,
    kind: string,
    role: "status" | "assistant" = "status",
  ): void {
    const identity = this.laneIdentityForJob(job, repoPath);
    this.options.historyStore?.add(identity.historyKey, {
      role,
      text,
      ts: Date.now(),
      kind,
    });
    this.broadcastJobEvent(job, {
      type: "message",
      role,
      text,
      jobId: job.id,
      ts: Date.now(),
    }, repoPath);
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
        head_sha: job.head_sha ?? resolveAssignedBranchHead(repoPath, job.branch),
      });
      this.recordActionMessage(job, repoPath, formatActionBlockedCard({
        job,
        classification: "infrastructure",
        failureStage: input.stage,
        failure,
        guidanceNote: "The environment must be fixed before this job can continue; no rework attempt was spent.",
      }), "action_blocked", "assistant");
      this.queueNextJobAfterBlocked(job, repoPath);
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
        : `Actions rework budget exhausted after ${MAX_REWORK_ATTEMPTS} attempts.`;
      this.updateJobStatus(job.id, "blocked", {
        rework_count: attemptIndex,
        current_step: reason,
        attempts_json: attemptsJson,
        error_message: failure,
        blocked_at: Date.now(),
        head_sha: job.head_sha ?? resolveAssignedBranchHead(repoPath, job.branch),
      });
      this.recordActionMessage(job, repoPath, formatActionBlockedCard({
        job,
        classification: "rework-exhausted",
        failureStage: input.stage,
        failure,
        attempts,
        guidanceNote: reason,
      }), "action_blocked", "assistant");
      this.queueNextJobAfterBlocked(job, repoPath);
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

  private queueNextJobAfterBlocked(job: ActionJobRecord, repoPath: string): void {
    // The supervised Developer evaluates the queue from its own release path,
    // after the workspace lock is free. Runners without a session manager have
    // no such path, so evaluate once the blocking transition is recorded.
    if (this.options.sessionManager && !this.options.developerRunner) return;
    queueMicrotask(() => {
      void this.evaluateQueue(job.project_id, repoPath, job.auth_user_id ?? undefined);
    });
  }

  private updateJobStatus(
    jobId: string,
    status: ActionJobStatus,
    updates?: Partial<Pick<ActionJobRecord, "current_step" | "steps_json" | "review_verdicts_json" | "attempts_json" | "pr_number" | "pr_url" | "error_message" | "branch" | "base_sha" | "head_sha" | "rework_count" | "blocked_at">>,
  ): ActionJobRecord | null {
    const current = getActionJobById(this.db, jobId);
    const nextUpdates = { ...(updates ?? {}) };
    const nextStep = String(nextUpdates.current_step ?? "").trim();
    if (current && nextStep && nextStep !== current.current_step) {
      const steps = parseActionJobSteps(current.steps_json);
      steps.push({ status, step: nextStep, ts: Date.now() });
      nextUpdates.steps_json = JSON.stringify(steps);
    }
    const updated = this.db.transaction(() => {
      updateActionJobStatus(this.db, jobId, status, nextUpdates);
      return getActionJobById(this.db, jobId);
    })();
    if (updated && this.options.broadcastToActionsLane) {
      this.broadcastJobEvent(updated, {
        type: "action_job_updated",
        jobId: updated.id,
        issueId: updated.issue_id,
        status: updated.status,
        currentStep: updated.current_step,
        steps: parseActionJobSteps(updated.steps_json),
        reworkCount: updated.rework_count,
        projectId: updated.project_id,
        ts: Date.now(),
      });
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

    const job = this.db.transaction(() => {
      const laneGeneration = laneIdentity
        ? this.options.captureActionsLaneGeneration?.(laneIdentity.logicalHistoryKey) ?? 1
        : 1;
      return createActionJob(this.db, {
        id,
        project_id: projectId,
        lane_generation: laneGeneration,
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
    })();

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
      if (getActionJobById(this.db, nextJob.id)?.status !== "queued") {
        return { allowed: false, reason: "Queued job changed during runtime preflight" };
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

      // Runtime discovery can yield. Re-read the gate so a cancellation or
      // reset during preflight cannot start the captured queued record.
      const currentGate = checkThreePointGate(this.db, repoPath, canonicalProjectId, "dev", supervised);
      if (!currentGate.allowed) return currentGate;

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
      this.developerProjects.set(projectId, jobId);

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
        this.broadcastJobEvent(job, {
          type: "message",
          role: "user",
          text: finalTaskPrompt,
          ts: Date.now(),
          jobId: job.id,
        }, repoPath);
      }

      let unsubscribe: (() => void) | null = null;
      const detach = () => { unsubscribe?.(); unsubscribe = null; };
      try {
        const execute = async () => {
          if (getActionJobById(this.db, jobId)?.status !== "running") return;
          const orchestrator = sessionManager.getOrCreate(userId, repoPath, true, {
            authUserId,
            projectId,
          });

          // A job keeps one main-agent session across continuation turns. Only a
          // different job, or an explicit lane reset, starts a new provider thread.
          const sessionKey = `${authUserId}\u0000${historyKey}`;
          if (this.developerSessionJobs.get(sessionKey) !== job.id) {
            orchestrator.reset?.();
            this.developerSessionJobs.set(sessionKey, job.id);
          }

          // Inject developer instructions from database profile
          if (typeof orchestrator.setDeveloperInstructions === "function") {
            orchestrator.setDeveloperInstructions(systemPrompt);
          }

          // Attach event listener for real-time WebSocket streaming
          const recordedActionSteps = new Set<string>();
          unsubscribe = orchestrator.onEvent((event: AgentEvent) => {
            const payload = buildActionAgentEventPayload(event, job.id);
            if (Object.keys(payload).length === 0) return;
            if (this.options.broadcastToActionsLane) {
              this.broadcastJobEvent(job, payload, repoPath);
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
            if (this.options.historyStore && payload.type === "action_step") {
              const stepIdentity = String(payload.identity ?? payload.id ?? "").trim();
              const stepKey = stepIdentity || buildActionStepHistoryText(payload);
              if (!recordedActionSteps.has(stepKey)) {
                recordedActionSteps.add(stepKey);
                this.options.historyStore.add(historyKey, {
                  role: "status",
                  text: buildActionStepHistoryText(payload),
                  ts: Number(payload.timestamp) || Date.now(),
                  kind: stepIdentity ? `action_step:${stepIdentity}` : "action_step",
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
            this.broadcastJobEvent(job, {
              type: "assistant_done",
              text: turnResult.response,
              jobId: job.id,
              ts: Date.now(),
            }, repoPath);
          }

          if (this.activeAbortControllers.get(jobId) === abortCtrl) {
            this.activeAbortControllers.delete(jobId);
          }

          if (getActionJobById(this.db, jobId)?.status !== "completed") {
            this.scheduleRework(jobId, repoPath, {
              stage: "Developer supervision",
              feedback: "Developer ended without reviewed delivery. " + turnResult.response.slice(-1500),
              reworkCount,
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
        if (this.activeAbortControllers.get(jobId) === abortCtrl) {
          this.activeAbortControllers.delete(jobId);
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
            failureClass: "infrastructure",
          });
        }
      } finally {
        detach();
        if (this.activeAbortControllers.get(jobId) === abortCtrl) {
          this.activeAbortControllers.delete(jobId);
        }
        if (this.developerProjects.get(projectId) === jobId) {
          this.developerProjects.delete(projectId);
        }
        const finalStatus = getActionJobById(this.db, jobId)?.status;
        if (finalStatus === "completed" || finalStatus === "blocked") {
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
        const deliveryHead = approved.split(":")[1]!;
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
      deliver: (approved) => {
        const deliveryHead = approved.split(":")[1]!;
        this.activeDeliveryHeads.set(job.id, deliveryHead);
        try {
          const result = this.handleReviewResult({ jobId: job.id, repoPath, verdict: "PASS", reviewSummary: "Approved by supervised Reviewer", supervised: true, expectedHead: deliveryHead });
          return { ok: result.status === "completed", ...result };
        } finally { this.activeDeliveryHeads.delete(job.id); }
      },
    });
  }

  private async runInteractiveCommand(
    command: string,
    args: string[],
    repoPath: string,
    signal?: AbortSignal,
    timeoutMs = normalizeInteractiveTimeout(
      this.options.interactiveCommandTimeoutMs,
      DEFAULT_INTERACTIVE_COMMAND_TIMEOUT_MS,
    ),
    maxOutputLength = 20_000,
  ): Promise<InteractiveCommandResult> {
    signal?.throwIfAborted();
    return await new Promise<InteractiveCommandResult>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: repoPath,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let escalation: ReturnType<typeof setTimeout> | undefined;

      const append = (current: string, chunk: Buffer | string): string =>
        `${current}${String(chunk)}`.slice(-maxOutputLength);
      const sendSignal = (name: NodeJS.Signals): void => {
        if (child.exitCode !== null) return;
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, name);
          else child.kill(name);
        } catch {
          try { child.kill(name); } catch { /* The process exited between checks. */ }
        }
      };
      const terminate = (): void => {
        sendSignal("SIGTERM");
        escalation = setTimeout(() => sendSignal("SIGKILL"), 1_000);
        escalation.unref();
      };
      const finish = (error?: Error, result?: InteractiveCommandResult): void => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (escalation) clearTimeout(escalation);
        if (signal) signal.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve(result!);
      };
      const onAbort = (): void => {
        terminate();
        finish(signal?.reason instanceof Error ? signal.reason : new Error("Interactive command aborted."));
      };

      const timeout = setTimeout(() => {
        terminate();
        finish(new Error(`Interactive command '${command}' timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (chunk: Buffer | string) => { stdout = append(stdout, chunk); });
      child.stderr.on("data", (chunk: Buffer | string) => { stderr = append(stderr, chunk); });
      child.once("error", (error) => finish(error));
      child.once("close", (code) => finish(undefined, {
        exitCode: code ?? 1,
        stdout,
        stderr,
      }));
    });
  }

  private async captureInteractiveWorkingTreeDiff(
    repoPath: string,
    baseCommit: string,
    headCommit: string,
    signal?: AbortSignal,
  ): Promise<InteractiveWorkspaceReviewTarget["workingTreeDiff"]> {
    const runGit = async (args: string[]): Promise<InteractiveCommandResult> =>
      await this.runInteractiveCommand(
        "git",
        args,
        repoPath,
        signal,
        normalizeInteractiveTimeout(this.options.interactiveCommandTimeoutMs, DEFAULT_INTERACTIVE_COMMAND_TIMEOUT_MS),
        2_000_000,
      );

    const committedDiff = await runGit(["diff", "--binary", `${baseCommit}...${headCommit}`]);
    if (committedDiff.exitCode !== 0) {
      throw new Error(`Unable to capture committed review diff: ${committedDiff.stderr.trim() || "git command failed"}`);
    }
    const workingTreeDiff = await runGit(["diff", "--binary", "HEAD"]);
    if (workingTreeDiff.exitCode !== 0) {
      throw new Error(`Unable to capture working-tree review diff: ${workingTreeDiff.stderr.trim() || "git command failed"}`);
    }
    const committedStat = await runGit(["diff", "--stat", `${baseCommit}...${headCommit}`]);
    if (committedStat.exitCode !== 0) {
      throw new Error(`Unable to capture committed review diff stat: ${committedStat.stderr.trim() || "git command failed"}`);
    }
    const workingTreeStat = await runGit(["diff", "--stat", "HEAD"]);
    if (workingTreeStat.exitCode !== 0) {
      throw new Error(`Unable to capture working-tree review diff stat: ${workingTreeStat.stderr.trim() || "git command failed"}`);
    }

    const untracked = await runGit(["ls-files", "--others", "--exclude-standard", "-z"]);
    if (untracked.exitCode !== 0) {
      throw new Error(`Unable to enumerate untracked review files: ${untracked.stderr.trim() || "git command failed"}`);
    }
    const untrackedDiffs: string[] = [];
    const untrackedStats: string[] = [];
    for (const file of untracked.stdout.split("\0").map(value => value.trim()).filter(Boolean)) {
      const diff = await runGit(["diff", "--no-index", "--binary", "--", "/dev/null", file]);
      if (diff.exitCode !== 0 && diff.exitCode !== 1) {
        throw new Error(`Unable to capture untracked review file '${file}': ${diff.stderr.trim() || "git command failed"}`);
      }
      if (diff.stdout.trim()) untrackedDiffs.push(diff.stdout.trimEnd());
      const stat = await runGit(["diff", "--no-index", "--stat", "--", "/dev/null", file]);
      if (stat.exitCode !== 0 && stat.exitCode !== 1) {
        throw new Error(`Unable to capture untracked review file stat '${file}': ${stat.stderr.trim() || "git command failed"}`);
      }
      if (stat.stdout.trim()) untrackedStats.push(stat.stdout.trimEnd());
    }

    return {
      diff: [committedDiff.stdout.trimEnd(), workingTreeDiff.stdout.trimEnd(), ...untrackedDiffs]
        .filter(Boolean)
        .join("\n"),
      diffStat: [committedStat.stdout.trimEnd(), workingTreeStat.stdout.trimEnd(), ...untrackedStats]
        .filter(Boolean)
        .join("\n"),
      range: `${baseCommit}...${headCommit} plus working tree`,
    };
  }

  private async readInteractiveGithubMetadata(input: {
    repoPath: string;
    branch: string;
    issueId: number;
    prNumber?: number | null;
  }, signal?: AbortSignal): Promise<InteractiveGithubMetadata> {
    if (this.options.interactiveGithubMetadataReader) {
      const metadata = await this.options.interactiveGithubMetadataReader(input);
      signal?.throwIfAborted();
      return metadata;
    }

    const prFields = "number,url,state,headRefName,baseRefName,baseRefOid,headRefOid";
    const prCommand = input.prNumber
      ? ["pr", "view", String(input.prNumber), "--json", prFields]
      : ["pr", "list", "--head", input.branch, "--state", "open", "--limit", "2", "--json", prFields];
    const prResult = await this.runInteractiveCommand("gh", prCommand, input.repoPath, signal);
    if (prResult.exitCode !== 0) {
      throw new Error(`Unable to resolve the GitHub pull request: ${prResult.stderr.trim() || "gh command failed"}`);
    }
    let prRecords: Array<Record<string, unknown>>;
    try {
      const parsed = JSON.parse(prResult.stdout || "[]") as unknown;
      prRecords = Array.isArray(parsed) ? parsed as Array<Record<string, unknown>> : [parsed as Record<string, unknown>];
    } catch (error) {
      throw new Error(`GitHub pull request metadata is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (prRecords.length !== 1) {
      throw new Error("Interactive review requires exactly one matching open pull request.");
    }
    const pr = prRecords[0]!;
    const pullRequest = {
      number: Number(pr.number),
      url: String(pr.url ?? "").trim(),
      state: String(pr.state ?? "").trim(),
      headRefName: String(pr.headRefName ?? ""),
      baseRefName: String(pr.baseRefName ?? ""),
      baseRefOid: String(pr.baseRefOid ?? ""),
      headRefOid: String(pr.headRefOid ?? ""),
    };
    if (!Number.isSafeInteger(pullRequest.number) || pullRequest.number < 1 || !pullRequest.url) {
      throw new Error("The matching pull request is missing its number or URL.");
    }

    const issueResult = await this.runInteractiveCommand(
      "gh",
      ["issue", "view", String(input.issueId), "--json", "number,title,body,state"],
      input.repoPath,
      signal,
    );
    if (issueResult.exitCode !== 0) {
      throw new Error(`Unable to resolve GitHub Issue #${input.issueId}: ${issueResult.stderr.trim() || "gh command failed"}`);
    }
    let issue: Record<string, unknown>;
    try {
      issue = JSON.parse(issueResult.stdout || "{}") as Record<string, unknown>;
    } catch (error) {
      throw new Error(`GitHub Issue metadata is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      pullRequest,
      issue: {
        number: Number(issue.number),
        title: String(issue.title ?? "").trim(),
        body: String(issue.body ?? "").trim(),
      },
    };
  }

  private async readInteractiveAdrSnapshot(
    repoPath: string,
    baseCommit: string,
    headCommit: string,
    signal?: AbortSignal,
  ): Promise<Array<{ id: string; title: string; decision: string }>> {
    const changed = await this.runInteractiveCommand(
      "git",
      ["diff", "--name-only", `${baseCommit}...${headCommit}`],
      repoPath,
      signal,
    );
    if (changed.exitCode !== 0) {
      throw new Error(`Unable to capture changed ADR files: ${changed.stderr.trim() || "git command failed"}`);
    }
    const files = String(changed.stdout)
      .split(/\r?\n/)
      .map((file) => file.trim())
      .filter((file) => /^docs\/adr\/[^/]+\.md$/.test(file));
    return files.map((file) => {
      let content: string;
      try {
        content = readFileSync(path.join(repoPath, file), "utf8");
      } catch (error) {
        throw new Error(`Unable to read changed ADR '${file}': ${error instanceof Error ? error.message : String(error)}`);
      }
      const title = /^#\s+(.+)$/m.exec(content)?.[1]?.trim() ?? path.basename(file, ".md");
      const decision = /(?:^|\n)##\s+Decision\s*\n([\s\S]*?)(?=\n##\s|$)/i.exec(content)?.[1]?.trim() ?? content.trim();
      return { id: path.basename(file, ".md"), title, decision };
    });
  }

  private async resolveInteractiveProjectContext(
    input: InteractiveReviewTargetRequest,
    signal?: AbortSignal,
  ): Promise<{ projectId: string; repoPath: string; authUserId: string }> {
    signal?.throwIfAborted();
    const repoPath = path.resolve(String(input.repoPath ?? "").trim());
    const authUserId = String(input.authUserId ?? "").trim();
    const projectId = resolveCanonicalProjectId(input.projectId, repoPath);
    if (!repoPath || !authUserId || !projectId) {
      throw new Error("Interactive review requires an authenticated project workspace.");
    }

    const identity = resolveActionsLaneIdentity(this.db, {
      projectId,
      repoPath,
      authUserId,
    });
    if (!identity || identity.authUserId !== authUserId || identity.projectId !== projectId) {
      throw new Error("Interactive review is limited to the authenticated Actions project workspace.");
    }
    return { projectId, repoPath, authUserId };
  }

  private async resolveInteractiveWorkspaceTarget(
    input: InteractiveReviewTargetRequest,
    signal?: AbortSignal,
  ): Promise<InteractiveWorkspaceReviewTarget> {
    const { projectId, repoPath, authUserId } = await this.resolveInteractiveProjectContext(input, signal);
    const git = async (args: string[], label: string): Promise<string> => {
      const result = await this.runInteractiveCommand("git", args, repoPath, signal);
      if (result.exitCode !== 0) {
        throw new Error(`${label}: ${result.stderr.trim() || "command failed"}`);
      }
      return result.stdout.trim();
    };

    const branch = (await git(["branch", "--show-current"], "Unable to determine the current workspace branch")) || "(detached HEAD)";
    const remote = await this.runInteractiveCommand("git", ["remote", "get-url", "origin"], repoPath, signal);
    const baseRef = remote.exitCode === 0 && remote.stdout.trim() ? "origin/dev" : "dev";
    const baseCommit = await git(["rev-parse", "--verify", `${baseRef}^{commit}`], `Unable to resolve the ${ACTIONS_BASE_BRANCH} base branch`);
    const headCommit = await git(["rev-parse", "--verify", "HEAD^{commit}"], "Unable to resolve the current workspace commit");
    const workingTreeDiff = await this.captureInteractiveWorkingTreeDiff(repoPath, baseCommit, headCommit, signal);
    const reviewPrompt = String(input.reviewPrompt ?? "").trim();
    const description = reviewPrompt
      ? `Review the current workspace changes against this user request:\n\n${reviewPrompt}`
      : "Review the current committed and working-tree changes in the authenticated workspace.";

    return {
      projectId,
      repoPath,
      authUserId,
      branch,
      issue: {
        id: null,
        title: "Interactive workspace review",
        description,
        acceptanceCriteria: [],
      },
      adrs: await this.readInteractiveAdrSnapshot(repoPath, baseCommit, headCommit, signal),
      baseRef,
      headRef: "HEAD",
      baseCommit,
      headCommit,
      workingTreeDiff,
    };
  }

  private async resolveInteractiveTarget(
    input: InteractiveReviewTargetRequest,
    signal?: AbortSignal,
  ): Promise<InteractiveReviewTarget> {
    const { projectId, repoPath, authUserId } = await this.resolveInteractiveProjectContext(input, signal);

    const git = async (args: string[], label: string): Promise<string> => {
      const result = await this.runInteractiveCommand("git", args, repoPath, signal);
      if (result.exitCode !== 0) {
        throw new Error(`${label}: ${result.stderr.trim() || "command failed"}`);
      }
      return result.stdout.trim();
    };

    const branch = await git(["branch", "--show-current"], "Unable to determine the current feature branch");
    if (input.branch && input.branch !== branch) {
      throw new Error(`Requested branch '${input.branch}' does not match the current branch '${branch}'.`);
    }
    const issueMatch = /^codex\/issue-(\d+)$/.exec(branch);
    if (!issueMatch) {
      throw new Error("Interactive review requires the assigned codex/issue-<id> feature branch.");
    }
    const issueId = Number(issueMatch[1]);
    if (!Number.isSafeInteger(issueId) || issueId < 1) {
      throw new Error("The current feature branch does not identify a valid GitHub Issue.");
    }
    if (await git(["status", "--porcelain", "-uno"], "Unable to inspect tracked workspace state")) {
      throw new Error("Commit tracked changes before requesting interactive review or delivery.");
    }

    const remote = await this.runInteractiveCommand("git", ["remote", "get-url", "origin"], repoPath, signal);
    const baseRef = remote.exitCode === 0 && remote.stdout.trim() ? "origin/dev" : "dev";
    const baseCommit = await git(["rev-parse", "--verify", `${baseRef}^{commit}`], `Unable to resolve the ${ACTIONS_BASE_BRANCH} base branch`);
    const headCommit = await git(["rev-parse", "--verify", "HEAD^{commit}"], "Unable to resolve the current feature commit");
    const ancestry = await this.runInteractiveCommand("git", ["merge-base", "--is-ancestor", baseCommit, headCommit], repoPath, signal);
    if (ancestry.exitCode !== 0) {
      throw new Error(`The feature branch must descend from the current '${ACTIONS_BASE_BRANCH}' base.`);
    }

    const metadata = await this.readInteractiveGithubMetadata({
      repoPath,
      branch,
      issueId,
      prNumber: input.prNumber,
    }, signal);
    const pr = metadata.pullRequest;
    if (pr.state.toUpperCase() !== "OPEN"
      || pr.headRefName !== branch
      || pr.baseRefName !== ACTIONS_BASE_BRANCH
      || pr.headRefOid !== headCommit
      || pr.baseRefOid !== baseCommit) {
      throw new Error("The pull request does not match the current feature branch, base, or exact head commit.");
    }

    const issue = metadata.issue;
    const issueTitle = issue.title;
    const issueDescription = issue.body;
    const acceptanceCriteria = parseAcceptanceCriteria(issueDescription);
    if (issue.number !== issueId || !issueTitle || !issueDescription || acceptanceCriteria.length === 0) {
      throw new Error(`GitHub Issue #${issueId} does not provide a complete review specification.`);
    }

    return {
      projectId,
      repoPath,
      authUserId,
      branch,
      prNumber: pr.number,
      prUrl: pr.url,
      issue: {
        id: issueId,
        title: issueTitle,
        description: issueDescription,
        acceptanceCriteria,
      },
      adrs: await this.readInteractiveAdrSnapshot(repoPath, baseCommit, headCommit, signal),
      baseRef,
      headRef: "HEAD",
      baseCommit,
      headCommit,
    };
  }

  public async resolveInteractiveReviewTarget(input: InteractiveReviewTargetRequest): Promise<InteractiveReviewTarget> {
    return await this.resolveInteractiveTarget(input);
  }

  private async runInteractiveVerification(
    repoPath: string,
    signal: AbortSignal,
  ): Promise<ReviewPayload["testReport"]> {
    const command = String(this.options.testCommand ?? "npm test").trim();
    const parts = command.split(/\s+/).filter(Boolean);
    if (parts.length === 0) throw new Error("Interactive review verification command is empty.");
    signal.throwIfAborted();

    const timeoutMs = normalizeInteractiveTimeout(
      this.options.interactiveVerificationTimeoutMs,
      DEFAULT_INTERACTIVE_VERIFICATION_TIMEOUT_MS,
    );
    const result = await this.runInteractiveCommand(parts[0]!, parts.slice(1), repoPath, signal, timeoutMs);
    const output = [result.stdout, result.stderr]
      .map((value) => value.trim())
      .filter(Boolean)
      .join("\n");
    const report = {
      command,
      exitCode: result.exitCode,
      summary: output || (result.exitCode === 0 ? "Tests and checks passed successfully" : "Verification command failed"),
      output,
    };
    if (result.exitCode !== 0) throw new Error(`Verification failed: ${report.summary}`);
    return report;
  }

  private async resolveInteractiveReviewSession(
    input: InteractiveReviewTargetRequest,
    signal: AbortSignal,
  ): Promise<InteractiveReviewSession> {
    const workspaceTarget = await this.resolveInteractiveWorkspaceTarget(input, signal);
    try {
      const target = await this.resolveInteractiveTarget(input, signal);
      return {
        projectId: target.projectId,
        repoPath: target.repoPath,
        authUserId: target.authUserId,
        target,
        key: interactiveTargetKey(target),
        deliveryTarget: target,
        requirePinnedEvidence: true,
      };
    } catch {
      signal.throwIfAborted();
      return {
        projectId: workspaceTarget.projectId,
        repoPath: workspaceTarget.repoPath,
        authUserId: workspaceTarget.authUserId,
        target: workspaceTarget,
        key: interactiveWorkspaceTargetKey(workspaceTarget),
        requirePinnedEvidence: false,
        diffOverride: workspaceTarget.workingTreeDiff,
      };
    }
  }

  private async executeInteractiveReviewSession(
    session: InteractiveReviewSession,
    signal: AbortSignal,
    resolveCurrentSession: () => Promise<InteractiveReviewSession>,
  ): Promise<ReviewVerdict> {
    const key = `${session.authUserId}\u0000${session.key}`;
    if (this.interactiveReviewerTargets.has(key)) {
      throw new ActionJobReviewConflictError("An interactive review is already running for this target.");
    }
    this.interactiveReviewerTargets.add(key);
    try {
      signal.throwIfAborted();
      const testReport = await this.runInteractiveVerification(session.repoPath, signal);
      const verifiedSession = await resolveCurrentSession();
      if (verifiedSession.key !== session.key) {
        throw new ReviewerIncompleteError("Interactive review target changed during verification; no authoritative verdict is available.");
      }
      const payload = await captureReviewPayloadAsync(
        verifiedSession.target,
        verifiedSession.repoPath,
        {
          requirePinnedEvidence: verifiedSession.requirePinnedEvidence,
          testReport,
          ...(verifiedSession.diffOverride ? { diffOverride: verifiedSession.diffOverride } : {}),
        },
        async (args) => {
          const result = await this.runInteractiveCommand(
            "git",
            args,
            verifiedSession.repoPath,
            signal,
            normalizeInteractiveTimeout(this.options.interactiveCommandTimeoutMs, DEFAULT_INTERACTIVE_COMMAND_TIMEOUT_MS),
            2_000_000,
          );
          return { status: result.exitCode, stdout: result.stdout, stderr: result.stderr };
        },
      );
      const evidence = payload.diffRange;
      if (!evidence
        || evidence.baseCommit !== verifiedSession.target.baseCommit
        || evidence.headCommit !== verifiedSession.target.headCommit) {
        throw new ReviewerIncompleteError("Reviewer evidence did not remain pinned to the interactive review target.");
      }
      const capturedSession = await resolveCurrentSession();
      if (capturedSession.key !== verifiedSession.key) {
        throw new ReviewerIncompleteError("Interactive review target changed while capturing evidence; no authoritative verdict is available.");
      }
      return await this.executeReviewer(
        payload,
        verifiedSession.repoPath,
        undefined,
        undefined,
        signal,
        verifiedSession.authUserId,
      );
    } finally {
      this.interactiveReviewerTargets.delete(key);
    }
  }

  public async reviewInteractiveTarget(input: InteractiveReviewTargetRequest): Promise<IndependentReviewResult> {
    const controller = new AbortController();
    const target = await this.resolveInteractiveTarget(input, controller.signal);
    const session = {
      projectId: target.projectId,
      repoPath: target.repoPath,
      authUserId: target.authUserId,
      target,
      key: interactiveTargetKey(target),
      deliveryTarget: target,
      requirePinnedEvidence: true,
    } satisfies InteractiveReviewSession;
    const verdict = await this.executeInteractiveReviewSession(session, controller.signal, async () => {
      const current = await this.resolveInteractiveTarget(input, controller.signal);
      return {
        projectId: current.projectId,
        repoPath: current.repoPath,
        authUserId: current.authUserId,
        target: current,
        key: interactiveTargetKey(current),
        deliveryTarget: current,
        requirePinnedEvidence: true,
      } satisfies InteractiveReviewSession;
    });
    return {
      status: verdict.status,
      summary: verdict.summary,
      defects: verdict.defects.map((defect) => ({
        file: defect.file,
        ...(defect.line === undefined ? {} : { line: defect.line }),
        severity: defect.severity,
        description: defect.description,
      })),
    };
  }

  public createInteractiveActionTools(
    input: InteractiveReviewTargetRequest & { signal: AbortSignal },
  ): Promise<ActionTools & { dispose: () => Promise<void> }> {
    return this.createInteractiveActionToolsAsync(input);
  }

  private async createInteractiveActionToolsAsync(
    input: InteractiveReviewTargetRequest & { signal: AbortSignal },
  ): Promise<ActionTools & { dispose: () => Promise<void> }> {
    let deliveryTarget: InteractiveReviewTarget | undefined;
    const supervision = createActionSupervision({
      signal: input.signal,
      snapshot: async () => (await this.resolveInteractiveReviewSession(input, input.signal)).key,
      review: async (signal) => {
        deliveryTarget = undefined;
        const session = await this.resolveInteractiveReviewSession(input, signal);
        const verdict = await this.executeInteractiveReviewSession(
          session,
          signal,
          () => this.resolveInteractiveReviewSession(input, signal),
        );
        if (verdict.status === "PASS") deliveryTarget = session.deliveryTarget;
        return verdict;
      },
      assertDeliveryTarget: async (approved) => {
        if (!deliveryTarget) {
          throw new Error("Delivery requires a PASS from a PR-scoped review. Create a matching pull request and call review_action again.");
        }
        const target = await this.resolveInteractiveTarget(input, input.signal);
        if (interactiveTargetKey(target) !== approved || interactiveTargetKey(target) !== interactiveTargetKey(deliveryTarget)) {
          throw new Error("Delivery target changed. Call review_action again.");
        }
      },
      deliver: async (approved) => {
        if (!deliveryTarget) {
          throw new Error("Delivery requires a PASS from a PR-scoped review. Create a matching pull request and call review_action again.");
        }
        const target = await this.resolveInteractiveTarget(input, input.signal);
        if (interactiveTargetKey(target) !== approved || interactiveTargetKey(target) !== interactiveTargetKey(deliveryTarget)) {
          throw new Error("Delivery target changed. Call review_action again.");
        }
        const mergeResult = (this.options.mergePipeline ?? mergeAndCleanupPipeline)({
          cwd: target.repoPath,
          prNumber: target.prNumber,
          issueId: target.issue.id,
          branch: target.branch,
          baseBranch: ACTIONS_BASE_BRANCH,
          expectedHead: target.headCommit ?? undefined,
          expectedBaseSha: target.baseCommit ?? undefined,
        });
        return { ok: mergeResult.success, ...(mergeResult.error ? { error: mergeResult.error } : {}), ...mergeResult };
      },
    });
    return supervision;
  }

  public async executeReviewer(
    payload: ReviewPayload,
    repoPath: string,
    reviewerProfileId?: string,
    jobId?: string,
    signal?: AbortSignal,
    ownerOverride?: string,
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
      const owner = ownerOverride ?? (jobId ? getActionJobById(this.db, jobId)?.auth_user_id : null) ?? "";
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

  public async reviewFailedJob(jobId: string, repoPath: string): Promise<IndependentReviewResult> {
    const job = getActionJobById(this.db, jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    if (job.status !== "failed") {
      throw new ActionJobReviewConflictError(
        `Independent review is only available for failed Actions jobs; current status is '${job.status}'.`,
      );
    }
    if (this.independentReviewerJobs.has(jobId)) {
      throw new ActionJobReviewConflictError("An independent review is already running for this Actions job.");
    }

    this.independentReviewerJobs.add(jobId);
    const runReview = async (): Promise<IndependentReviewResult> => {
      const current = getActionJobById(this.db, jobId);
      if (!current || current.status !== "failed") {
        throw new ActionJobReviewConflictError(
          `Independent review is only available for failed Actions jobs; current status is '${current?.status ?? "missing"}'.`,
        );
      }

      const identity = this.laneIdentityForJob(current, repoPath);
      const history = this.options.historyStore?.get?.(identity.historyKey) ?? [];
      const payload = captureActionJobReviewPayload(
        current,
        repoPath,
        findVerificationReport(current, history),
        true,
      );

      let reviewerProfileId: string | undefined;
      try {
        const selectedProfiles = JSON.parse(current.reviewer_profile_ids_json) as unknown;
        if (Array.isArray(selectedProfiles) && typeof selectedProfiles[0] === "string") {
          reviewerProfileId = selectedProfiles[0];
        }
      } catch {
        throw new Error("Independent review failed: stored Reviewer profile selection is invalid.");
      }

      const verdict = await this.executeReviewer(
        payload,
        repoPath,
        reviewerProfileId,
        current.id,
      );
      const result: IndependentReviewResult = {
        status: verdict.status,
        summary: verdict.summary,
        defects: verdict.defects.map((defect) => ({
          file: defect.file,
          ...(defect.line === undefined ? {} : { line: defect.line }),
          severity: defect.severity,
          description: defect.description,
        })),
      };
      const reviewCardText = formatReviewVerdictCard(result);
      this.broadcastJobEvent(current, {
        type: "message",
        role: "assistant",
        text: reviewCardText,
        jobId: current.id,
        ts: Date.now(),
        status: result.status,
      }, repoPath);
      this.options.historyStore?.add(identity.historyKey, {
        role: "assistant",
        text: reviewCardText,
        ts: Date.now(),
        kind: "review_verdict",
      });
      return result;
    };

    try {
      return await runReview();
    } finally {
      this.independentReviewerJobs.delete(jobId);
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
      this.broadcastJobEvent(job, {
        type: "command",
        command: testCmd,
        output: testReport.summary,
        exitCode: testReport.exitCode,
        status: testReport.exitCode === 0 ? "completed" : "failed",
        jobId: job.id,
        ts: Date.now(),
      }, repoPath);
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

    const payload = captureActionJobReviewPayload(job, repoPath, testReport);

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
    const reviewCardText = formatReviewVerdictCard(verdict);

    if (this.options.broadcastToActionsLane) {
      this.broadcastJobEvent(job, {
        type: "message",
        role: "assistant",
        text: reviewCardText,
        jobId: job.id,
        ts: Date.now(),
        status: verdict.status,
      }, repoPath);
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

      const identity = this.laneIdentityForJob(job, params.repoPath);
      const historyKey = identity.historyKey;
      const deliveryText = hasRemote
        ? `Review approved. PR #${prNumber} created (${prUrl}). Starting automatic merge and cleanup.`
        : "Review approved. Starting automatic local merge and cleanup.";

      if (this.options.broadcastToActionsLane) {
        this.broadcastJobEvent(job, {
          type: "message",
          role: "status",
          text: deliveryText,
          jobId: job.id,
          ts: Date.now(),
          kind: `pr_delivery:${job.id}`,
        }, params.repoPath);
      }

      if (this.options.historyStore) {
        this.options.historyStore.add(historyKey, {
          role: "status",
          text: deliveryText,
          ts: Date.now(),
          kind: `pr_delivery:${job.id}`,
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
      head_sha: job.head_sha ?? resolveAssignedBranchHead(targetRepo, job.branch),
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
