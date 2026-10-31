import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Database as DatabaseType } from "better-sqlite3";

import type { ActionToolResult, ActionTools } from "../agents/actionTools.js";
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
  type ActionJobIssueSnapshot,
  type ActionJobRecord,
} from "../state/actionJobStore.js";
import {
  ACTIONS_BASE_BRANCH,
} from "./pipeline.js";
import { deriveProjectSessionId } from "../web/server/projectSessionId.js";
import { buildWsConnectionIdentity } from "../web/server/ws/connectionIdentity.js";
import { resolveActionsLaneIdentity } from "./laneIdentity.js";
import {
  captureReviewPayloadAsync,
  type ReviewTarget,
} from "./reviewService.js";

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

export type ReviewerRunner = (prompt: string, systemPrompt: string) => Promise<string>;

const DEFAULT_REVIEWER_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_INTERACTIVE_VERIFICATION_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_INTERACTIVE_COMMAND_TIMEOUT_MS = 30 * 1000;
const processingReviewQueuesByDatabase = new WeakMap<DatabaseType, Map<string, Promise<void>>>();

function getProcessingReviewQueues(db: DatabaseType): Map<string, Promise<void>> {
  const existing = processingReviewQueuesByDatabase.get(db);
  if (existing) return existing;
  const queues = new Map<string, Promise<void>>();
  processingReviewQueuesByDatabase.set(db, queues);
  return queues;
}

export class ActionJobReviewConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionJobReviewConflictError";
  }
}

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
};

type InteractiveReviewSession = {
  projectId: string;
  repoPath: string;
  authUserId: string;
  target: InteractiveReviewTarget;
  key: string;
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
    body: string;
  };
  openPullRequests: Array<{ number: number; headRefName: string }>;
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
  reviewerRunner?: ReviewerRunner;
  historyStore?: {
    add: (key: string, entry: { role: string; text: string; ts: number; kind?: string }) => void;
  };
  captureActionsLaneGeneration?: (logicalHistoryKey: string) => number;
  broadcastToActionsLane?: (payload: unknown, logicalHistoryKey: string, projectId: string, laneGeneration: number) => void;
  autoStartReviewQueue?: boolean;
  testCommand?: string;
  interactiveCommandTimeoutMs?: number;
  interactiveVerificationTimeoutMs?: number;
  reviewerTimeoutMs?: number;
  reviewerToolTurnBudget?: number;
  reviewerComplete?: typeof completeNativeChat;
  reviewerModelResolver?: (modelId: string, owner: string) => NativeModelConfig;
  interactiveGithubMetadataReader?: (input: {
    repoPath: string;
    branch: string;
    issueId: number;
    prNumber?: number | null;
  }) => InteractiveGithubMetadata | Promise<InteractiveGithubMetadata>;
  interactiveOpenPullRequestReader?: (input: {
    repoPath: string;
    baseRefName: string;
  }) => Array<{ number: number; headRefName: string }> | Promise<Array<{ number: number; headRefName: string }>>;
}

export class LaneDispatchBus {
  private interactiveReviewerTargets = new Set<string>();
  private readonly processingReviewQueues: Map<string, Promise<void>>;

  constructor(
    private db: DatabaseType,
    private options: LaneDispatchBusOptions = {},
  ) {
    this.processingReviewQueues = getProcessingReviewQueues(db);
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

    const prFields = "number,url,state,headRefName,baseRefName,baseRefOid,headRefOid,body";
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
      body: String(pr.body ?? ""),
    };
    if (!Number.isSafeInteger(pullRequest.number) || pullRequest.number < 1 || !pullRequest.url) {
      throw new Error("The matching pull request is missing its number or URL.");
    }

    const openPullRequestsResult = await this.runInteractiveCommand(
      "gh",
      ["pr", "list", "--state", "open", "--base", ACTIONS_BASE_BRANCH, "--json", "number,headRefName"],
      input.repoPath,
      signal,
    );
    if (openPullRequestsResult.exitCode !== 0) {
      throw new Error(`Unable to inspect open pull requests: ${openPullRequestsResult.stderr.trim() || "gh command failed"}`);
    }
    let openPullRequests: Array<{ number: number; headRefName: string }>;
    try {
      const parsed = JSON.parse(openPullRequestsResult.stdout || "[]") as unknown;
      if (!Array.isArray(parsed)) throw new Error("expected an array");
      openPullRequests = parsed.map((record) => {
        const item = record as Record<string, unknown>;
        return { number: Number(item.number), headRefName: String(item.headRefName ?? "") };
      });
    } catch (error) {
      throw new Error(`Open pull request metadata is invalid: ${error instanceof Error ? error.message : String(error)}`);
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
      openPullRequests,
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
      throw new Error("Interactive review is limited to the authenticated project workspace.");
    }
    return { projectId, repoPath, authUserId };
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
      throw new Error("Commit tracked changes before requesting an interactive review.");
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
    if (metadata.openPullRequests.length !== 1 || metadata.openPullRequests[0]?.number !== pr.number) {
      throw new Error("Only one open pull request may target the repository base while implementation is in progress.");
    }
    const issueReference = new RegExp(`(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\\s+#${issueId}\\b`, "i");
    if (!issueReference.test(pr.body)) {
      throw new Error(`The pull request must link GitHub Issue #${issueId} in its description.`);
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
  ): Promise<NonNullable<ReviewPayload["testReport"]>> {
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
    return report;
  }

  private async resolveInteractiveReviewSession(
    input: InteractiveReviewTargetRequest,
    signal?: AbortSignal,
  ): Promise<InteractiveReviewSession> {
    const target = await this.resolveInteractiveTarget(input, signal);
    return {
      projectId: target.projectId,
      repoPath: target.repoPath,
      authUserId: target.authUserId,
      target,
      key: interactiveTargetKey(target),
    };
  }

  private async executeInteractiveReviewSession(
    session: InteractiveReviewSession,
    signal: AbortSignal,
    resolveCurrentSession: () => Promise<InteractiveReviewSession>,
    job: ActionJobRecord,
  ): Promise<{ verdict: ReviewVerdict; testReport: NonNullable<ReviewPayload["testReport"]> }> {
    const key = `${session.authUserId}\u0000${session.key}`;
    if (this.interactiveReviewerTargets.has(key)) {
      throw new ActionJobReviewConflictError("An interactive review is already running for this target.");
    }
    this.interactiveReviewerTargets.add(key);
    try {
      signal.throwIfAborted();
      const testReport = await this.runInteractiveVerification(session.repoPath, signal);
      updateActionJobStatus(this.db, job.id, "verifying", {
        current_step: `Verification completed: ${testReport.command} (exit ${testReport.exitCode})`,
        verification_report_json: JSON.stringify(testReport),
      });
      this.recordActionMessage(
        job,
        session.repoPath,
        `Review job ${job.id}: verification ${testReport.exitCode === 0 ? "passed" : "failed"} (${testReport.command}, exit ${testReport.exitCode}).`,
        `action_step:${job.id}:verification`,
      );
      if (testReport.exitCode !== 0) throw new Error(`Verification failed: ${testReport.summary}`);
      const verifiedSession = await resolveCurrentSession();
      if (verifiedSession.key !== session.key) {
        throw new ReviewerIncompleteError("Interactive review target changed during verification; no authoritative verdict is available.");
      }
      const payload = await captureReviewPayloadAsync(
        verifiedSession.target,
        verifiedSession.repoPath,
        {
          requirePinnedEvidence: true,
          testReport,
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
      updateActionJobStatus(this.db, job.id, "reviewing", {
        current_step: `Running read-only Reviewer for PR #${job.pr_number}`,
      });
      this.recordActionMessage(
        job,
        session.repoPath,
        `Review job ${job.id}: running the read-only Reviewer for PR #${job.pr_number} at ${job.head_sha?.slice(0, 12)}.`,
        `action_step:${job.id}:reviewing`,
      );
      const verdict = await this.executeReviewer(
        payload,
        verifiedSession.repoPath,
        this.parseReviewerProfileId(job),
        job.id,
        signal,
        verifiedSession.authUserId,
      );
      const reviewedSession = await resolveCurrentSession();
      if (reviewedSession.key !== verifiedSession.key) {
        throw new ReviewerIncompleteError("The pull request changed during review; no authoritative verdict is available.");
      }
      return { verdict, testReport };
    } finally {
      this.interactiveReviewerTargets.delete(key);
    }
  }

  private laneIdentityForJob(job: ActionJobRecord, repoPath: string) {
    if (job.auth_user_id && job.chat_session_id) {
      const identity = {
        authUserId: job.auth_user_id,
        sessionId: job.project_id,
        chatSessionId: job.chat_session_id,
        connectionId: "actions",
      };
      return {
        ...buildWsConnectionIdentity({ ...identity, generation: job.lane_generation }),
        logicalHistoryKey: buildWsConnectionIdentity(identity).historyKey,
      };
    }
    return resolveActionsLaneIdentity(this.db, {
      projectId: job.project_id,
      repoPath,
      authUserId: job.auth_user_id,
      generation: job.lane_generation,
    });
  }

  private recordActionMessage(
    job: ActionJobRecord,
    repoPath: string,
    text: string,
    kind: string,
    role: "status" | "assistant" = "status",
  ): void {
    const identity = this.laneIdentityForJob(job, repoPath);
    if (!identity) return;
    const ts = Date.now();
    const id = `${job.id}:${kind}:${ts}`;
    try {
      this.options.historyStore?.add(identity.historyKey, { role, text, ts, kind });
    } catch (error) {
      console.warn(`[actions] Unable to persist Reviewer message for job '${job.id}':`, error);
    }
    try {
      this.options.broadcastToActionsLane?.({
        type: "message",
        role,
        text,
        jobId: job.id,
        kind,
        id,
        eventId: id,
        ts,
      }, identity.logicalHistoryKey, job.project_id, job.lane_generation);
    } catch (error) {
      console.warn(`[actions] Unable to broadcast Reviewer message for job '${job.id}':`, error);
    }
  }

  private parseReviewerProfileId(job: ActionJobRecord): string | undefined {
    try {
      const ids = JSON.parse(job.reviewer_profile_ids_json) as unknown;
      return Array.isArray(ids) && typeof ids[0] === "string" ? ids[0] : undefined;
    } catch {
      return undefined;
    }
  }

  private reviewTargetMatchesJob(job: ActionJobRecord, target: InteractiveReviewTarget): boolean {
    if (job.job_kind !== "pull_request_review"
      || job.issue_id !== target.issue.id
      || job.branch !== target.branch
      || job.pr_number !== target.prNumber
      || job.pr_url !== target.prUrl
      || job.base_sha !== target.baseCommit
      || job.head_sha !== target.headCommit) return false;
    try {
      const snapshot = JSON.parse(job.issue_snapshot_json) as ActionJobIssueSnapshot;
      return snapshot.title === target.issue.title
        && snapshot.description === target.issue.description
        && JSON.stringify(snapshot.acceptanceCriteria) === JSON.stringify(target.issue.acceptanceCriteria)
        && JSON.stringify(snapshot.adrs) === JSON.stringify(target.adrs);
    } catch {
      return false;
    }
  }

  public async dispatchReviewJob(
    input: InteractiveReviewTargetRequest & { signal?: AbortSignal },
  ): Promise<ActionToolResult> {
    const session = await this.resolveInteractiveReviewSession(input, input.signal);
    const target = session.target;
    if (!target.baseCommit || !target.headCommit) {
      throw new ReviewerIncompleteError("The review target is missing exact base or head commit evidence.");
    }
    const issueId = Number(target.issue.id);
    if (!Number.isSafeInteger(issueId) || issueId < 1) {
      throw new ReviewerIncompleteError("The review target is missing its GitHub Issue number.");
    }
    this.failInterruptedReviewJobs(target.projectId, target.repoPath);
    const reviewerProfile = getDefaultRoleProfile(this.db, "reviewer");
    if (!reviewerProfile || reviewerProfile.role !== "reviewer" || !reviewerProfile.is_enabled
      || !reviewerProfile.model_id.trim() || !reviewerProfile.system_prompt.trim()) {
      throw new Error("Configure an enabled Reviewer profile with a model and system prompt before dispatching a review.");
    }

    const existing = getActionJobs(this.db, target.projectId, undefined, target.authUserId).find((job) =>
      job.job_kind === "pull_request_review"
      && job.pr_number === target.prNumber
      && job.base_sha === target.baseCommit
      && job.head_sha === target.headCommit
      && ["queued", "verifying", "reviewing"].includes(job.status),
    );
    if (existing) {
      await raceReviewerAbort(this.processReviewQueue(target.projectId, target.repoPath), input.signal ?? new AbortController().signal);
      return this.reviewJobToolResult(existing.id);
    }

    const identity = resolveActionsLaneIdentity(this.db, {
      projectId: target.projectId,
      repoPath: target.repoPath,
      authUserId: target.authUserId,
    });
    if (!identity) throw new Error("The authenticated Actions lane is unavailable for this project.");

    const id = randomUUID();
    const issueSnapshot: ActionJobIssueSnapshot = {
      title: target.issue.title,
      description: target.issue.description ?? target.issue.title,
      acceptanceCriteria: [...(target.issue.acceptanceCriteria ?? [])],
      adrs: (target.adrs ?? []).map((adr) => ({ ...adr })),
    };
    const job = createActionJob(this.db, {
      id,
      project_id: target.projectId,
      lane_generation: this.options.captureActionsLaneGeneration?.(identity.logicalHistoryKey) ?? 1,
      job_kind: "pull_request_review",
      issue_id: issueId,
      issue_title: target.issue.title,
      issue_snapshot: issueSnapshot,
      branch: target.branch,
      base_sha: target.baseCommit,
      head_sha: target.headCommit,
      reviewer_profile_ids_json: JSON.stringify([reviewerProfile.id]),
      pr_number: target.prNumber,
      pr_url: target.prUrl,
      auth_user_id: target.authUserId,
      chat_session_id: identity.chatSessionId,
    });
    updateActionJobStatus(this.db, job.id, "queued", {
      current_step: `Queued read-only review for PR #${target.prNumber} at ${target.headCommit.slice(0, 12)}`,
    });
    this.recordActionMessage(
      job,
      target.repoPath,
      `Queued Reviewer job ${job.id} for PR #${target.prNumber} at ${target.headCommit.slice(0, 12)} (base ${target.baseCommit.slice(0, 12)}).`,
      `action_step:${job.id}:queued`,
    );
    await raceReviewerAbort(this.processReviewQueue(target.projectId, target.repoPath), input.signal ?? new AbortController().signal);
    return this.reviewJobToolResult(job.id);
  }

  private reviewJobToolResult(jobId: string): ActionToolResult {
    const job = getActionJobById(this.db, jobId);
    if (!job) return { ok: false, jobId, error: "The Actions review job disappeared before returning a result." };
    if (job.status !== "completed") {
      return {
        ok: false,
        jobId,
        status: job.status,
        error: job.error_message || job.current_step || "The Actions review job did not produce an authoritative verdict.",
      };
    }
    try {
      const parsed = JSON.parse(job.review_verdicts_json) as unknown;
      if (Array.isArray(parsed)) {
        const verdict = parsed.at(-1) as ReviewVerdict | undefined;
        if (verdict && (verdict.status === "PASS" || verdict.status === "REJECT")) {
          return { ok: true, jobId, status: job.status, verdict };
        }
      }
    } catch {
      // A malformed or absent verdict is reported as an operational job failure below.
    }
    return {
      ok: false,
      jobId,
      status: job.status,
      error: job.error_message || job.current_step || "The Actions review job did not produce an authoritative verdict.",
    };
  }

  public resumeReviewQueue(projectId: string, repoPath: string): void {
    const canonicalProjectId = resolveCanonicalProjectId(projectId, repoPath);
    this.failInterruptedReviewJobs(canonicalProjectId, repoPath);
    this.queueReviewProcessing(canonicalProjectId, repoPath);
  }

  public async processReviewQueue(projectId: string, repoPath: string): Promise<void> {
    const canonicalProjectId = resolveCanonicalProjectId(projectId, repoPath);
    const key = canonicalProjectId;
    const active = this.processingReviewQueues.get(key);
    if (active) return await active;
    this.failInterruptedReviewJobs(canonicalProjectId, repoPath);
    const run = this.runReviewQueue(canonicalProjectId, repoPath);
    this.processingReviewQueues.set(key, run);
    try {
      await run;
    } finally {
      if (this.processingReviewQueues.get(key) === run) this.processingReviewQueues.delete(key);
    }
  }

  private queueReviewProcessing(projectId: string, repoPath: string): void {
    if (this.options.autoStartReviewQueue === false || this.processingReviewQueues.has(projectId)) return;
    const run = Promise.resolve().then(() => this.runReviewQueue(projectId, repoPath));
    this.processingReviewQueues.set(projectId, run);
    void run.catch((error) => {
      console.warn(`[actions] Reviewer queue failed for project '${projectId}':`, error);
    }).finally(() => {
      if (this.processingReviewQueues.get(projectId) === run) this.processingReviewQueues.delete(projectId);
      this.failInterruptedReviewJobs(projectId, repoPath);
      const hasQueuedReview = getActionJobs(this.db, projectId).some((job) =>
        job.job_kind === "pull_request_review" && job.status === "queued",
      );
      if (hasQueuedReview) this.queueReviewProcessing(projectId, repoPath);
    });
  }

  private failInterruptedReviewJobs(projectId: string, repoPath: string): void {
    if (this.processingReviewQueues.has(projectId)) return;
    const jobs = this.db.prepare(`
      SELECT * FROM action_jobs
      WHERE project_id = ? AND job_kind = 'pull_request_review' AND status IN ('verifying', 'reviewing')
    `).all(projectId) as ActionJobRecord[];
    const errorMessage = "The review job has no active worker. Dispatch a new review to retry the pinned target.";
    for (const job of jobs) {
      const now = Date.now();
      const result = this.db.prepare(`
        UPDATE action_jobs
        SET status = 'failed', current_step = 'Review job interrupted before producing a verdict',
            error_message = ?, review_verdicts_json = '[]', updated_at = ?
        WHERE id = ? AND status IN ('verifying', 'reviewing')
      `).run(errorMessage, now, job.id) as { changes?: number };
      if (result.changes !== 1) continue;
      this.recordActionMessage(
        getActionJobById(this.db, job.id) ?? job,
        repoPath,
        `Reviewer job ${job.id} was interrupted before producing a verdict. Dispatch a new review to retry the pinned target.`,
        `action_step:${job.id}:interrupted`,
      );
    }
  }

  private async runReviewQueue(projectId: string, repoPath: string): Promise<void> {
    while (true) {
      const job = getActionJobs(this.db, projectId)
        .filter((candidate) => candidate.job_kind === "pull_request_review" && candidate.status === "queued")
        .sort((left, right) => left.created_at - right.created_at)[0];
      if (!job) return;
      await this.executeQueuedReview(job, repoPath);
    }
  }

  private async executeQueuedReview(job: ActionJobRecord, repoPath: string): Promise<void> {
    const claim = this.db.prepare(`
      UPDATE action_jobs SET status = 'verifying', updated_at = ?
      WHERE id = ? AND job_kind = 'pull_request_review' AND status = 'queued'
    `).run(Date.now(), job.id) as { changes?: number };
    if (!claim.changes) return;
    const claimedJob = getActionJobById(this.db, job.id) ?? job;
    updateActionJobStatus(this.db, job.id, "verifying", {
      current_step: `Checking pinned target for PR #${job.pr_number}`,
      error_message: null,
      verification_report_json: "",
      review_verdicts_json: "[]",
    });
    this.recordActionMessage(
      claimedJob,
      repoPath,
      `Reviewer job ${job.id} started for PR #${job.pr_number}; verifying the pinned target before execution.`,
      `action_step:${job.id}:started`,
    );

    try {
      const request: InteractiveReviewTargetRequest = {
        projectId: job.project_id,
        repoPath,
        authUserId: job.auth_user_id ?? "",
        branch: job.branch ?? undefined,
        prNumber: job.pr_number,
      };
      const session = await this.resolveInteractiveReviewSession(request);
      if (!this.reviewTargetMatchesJob(job, session.target)) {
        throw new ReviewerIncompleteError("The pull request, Issue, base, head, or ADR snapshot changed after dispatch.");
      }
      const controller = new AbortController();
      const result = await this.executeInteractiveReviewSession(
        session,
        controller.signal,
        () => this.resolveInteractiveReviewSession(request),
        job,
      );
      updateActionJobStatus(this.db, job.id, "completed", {
        current_step: `${result.verdict.status}: ${result.verdict.summary}`,
        review_verdicts_json: JSON.stringify([result.verdict]),
        verification_report_json: JSON.stringify(result.testReport ?? {}),
        error_message: null,
      });
      const findings = result.verdict.defects.map((defect) => {
        const location = defect.line ? `${defect.file}:${defect.line}` : defect.file;
        return `- ${location} (${defect.severity}): ${defect.description}`;
      });
      this.recordActionMessage(
        getActionJobById(this.db, job.id) ?? claimedJob,
        repoPath,
        `Reviewer ${result.verdict.status} for PR #${job.pr_number} at ${job.head_sha?.slice(0, 12)}. ${result.verdict.summary}${findings.length ? `\n${findings.join("\n")}` : ""}`,
        `action_review_result:${job.id}`,
        "assistant",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateActionJobStatus(this.db, job.id, "failed", {
        current_step: "Review job failed before producing an authoritative verdict",
        error_message: message,
        review_verdicts_json: "[]",
      });
      this.recordActionMessage(
        getActionJobById(this.db, job.id) ?? claimedJob,
        repoPath,
        `Reviewer job ${job.id} failed for PR #${job.pr_number}: ${message}`,
        `action_step:${job.id}:failed`,
      );
    }
  }

  private async readInteractiveOpenPullRequests(
    repoPath: string,
    signal?: AbortSignal,
  ): Promise<Array<{ number: number; headRefName: string }>> {
    if (this.options.interactiveOpenPullRequestReader) {
      const pullRequests = await this.options.interactiveOpenPullRequestReader({
        repoPath,
        baseRefName: ACTIONS_BASE_BRANCH,
      });
      signal?.throwIfAborted();
      return pullRequests;
    }

    const remote = await this.runInteractiveCommand("git", ["remote", "get-url", "origin"], repoPath, signal);
    if (remote.exitCode !== 0 || !remote.stdout.trim()) return [];

    const result = await this.runInteractiveCommand(
      "gh",
      ["pr", "list", "--state", "open", "--base", ACTIONS_BASE_BRANCH, "--limit", "2", "--json", "number,headRefName"],
      repoPath,
      signal,
    );
    if (result.exitCode !== 0) {
      throw new Error(`Unable to inspect open pull requests: ${result.stderr.trim() || "gh command failed"}`);
    }
    try {
      const parsed = JSON.parse(result.stdout || "[]") as unknown;
      if (!Array.isArray(parsed)) throw new Error("expected an array");
      return parsed.map((record) => {
        const item = record as Record<string, unknown>;
        const number = Number(item.number);
        const headRefName = String(item.headRefName ?? "").trim();
        if (!Number.isSafeInteger(number) || number < 1 || !headRefName) {
          throw new Error("invalid pull request number or head branch");
        }
        return { number, headRefName };
      });
    } catch (error) {
      throw new Error(`Open pull request metadata is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public async beginInteractiveImplementation(input: InteractiveReviewTargetRequest & {
    issueId: number;
    signal?: AbortSignal;
  }): Promise<{ ok: true; issueId: number; branch: string; pullRequestNumber?: number }> {
    if (!Number.isSafeInteger(input.issueId) || input.issueId < 1) {
      throw new Error("Implementation requires a valid GitHub Issue number.");
    }
    const { repoPath } = await this.resolveInteractiveProjectContext(input, input.signal);
    const branchResult = await this.runInteractiveCommand("git", ["branch", "--show-current"], repoPath, input.signal);
    if (branchResult.exitCode !== 0) {
      throw new Error(`Unable to determine the current workspace branch: ${branchResult.stderr.trim() || "git command failed"}`);
    }
    const branch = branchResult.stdout.trim();
    const expectedBranch = `codex/issue-${input.issueId}`;
    if (branch !== ACTIONS_BASE_BRANCH && branch !== expectedBranch) {
      throw new Error(`Workspace is on '${branch}', not '${ACTIONS_BASE_BRANCH}' or '${expectedBranch}'. Finish the current repository task first.`);
    }
    if (branch === ACTIONS_BASE_BRANCH) {
      const statusResult = await this.runInteractiveCommand(
        "git",
        ["status", "--porcelain", "--untracked-files=all"],
        repoPath,
        input.signal,
      );
      if (statusResult.exitCode !== 0) {
        throw new Error(`Unable to verify the base workspace is clean: ${statusResult.stderr.trim() || "git command failed"}`);
      }
      if (statusResult.stdout.trim()) {
        throw new Error("The base workspace has uncommitted changes. Preserve or resolve them before starting a repository task.");
      }
    }

    const openPullRequests = await this.readInteractiveOpenPullRequests(repoPath, input.signal);
    if (openPullRequests.length > 1) {
      throw new Error("The repository has multiple open pull requests targeting dev. Resolve them before starting another task.");
    }
    const openPullRequest = openPullRequests[0];
    if (openPullRequest && (branch !== expectedBranch || openPullRequest.headRefName !== expectedBranch)) {
      throw new Error(`Open pull request #${openPullRequest.number} owns the repository task slot. Continue Issue #${input.issueId} only after checking out '${expectedBranch}'.`);
    }

    return {
      ok: true,
      issueId: input.issueId,
      branch,
      ...(openPullRequest ? { pullRequestNumber: openPullRequest.number } : {}),
    };
  }

  public createInteractiveActionTools(
    input: InteractiveReviewTargetRequest & { signal: AbortSignal },
  ): Promise<ActionTools & { dispose: () => Promise<void> }> {
    return Promise.resolve({
      review_action: async () => await this.dispatchReviewJob(input),
      begin_implementation: async ({ issue_id }) => await this.beginInteractiveImplementation({
        projectId: input.projectId,
        repoPath: input.repoPath,
        authUserId: input.authUserId,
        issueId: issue_id,
        signal: input.signal,
      }),
      dispose: async () => {},
    });
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


  public getJobs(projectId: string, repoPath?: string, authUserId?: string): ActionJobRecord[] {
    const canonicalProjectId = resolveCanonicalProjectId(projectId, repoPath);
    migrateLegacyProjectJobs(this.db, canonicalProjectId, [projectId, repoPath ?? ""]);
    return getActionJobs(this.db, canonicalProjectId, undefined, authUserId);
  }

  public getJob(jobId: string): ActionJobRecord | null {
    return getActionJobById(this.db, jobId);
  }
}
