import fs from "node:fs";
import path from "node:path";

import type { Logger } from "../../../utils/logger.js";
import { safeParseJson } from "../../../utils/json.js";
import { detectWorkspaceFrom } from "../../../workspace/detector.js";
import { DirectoryManager } from "../../../telegram/utils/directoryManager.js";
import { ThreadStorage } from "../../../telegram/utils/threadStorage.js";
import { SessionManager } from "../../../telegram/utils/sessionManager.js";
import { deriveProjectSessionId } from "../projectSessionId.js";

import { TaskQueue } from "../../../tasks/queue.js";
import { TaskStore as QueueTaskStore } from "../../../tasks/store.js";
import { OrchestratorTaskExecutor } from "../../../tasks/executor.js";
import { ReviewStore } from "../../../tasks/reviewStore.js";
import { AttachmentStore } from "../../../attachments/store.js";
import { TaskRunController } from "../../taskRunController.js";
import { broadcastTaskStart } from "../../taskStartBroadcast.js";
import type { AsyncLock } from "../../../utils/asyncLock.js";
import { buildWorkspacePatch, type WorkspacePatchPayload } from "../../gitPatch.js";
import { notifyTaskTerminalViaTelegram } from "../../taskNotifications/telegramNotifier.js";
import { extractJsonPayload } from "../../../agents/tasks/schemas.js";
import { z } from "zod";

export type TaskQueueMetricName =
  | "TASK_ADDED"
  | "TASK_STARTED"
  | "PROMPT_INJECTED"
  | "TASK_COMPLETED"
  | "INJECTION_SKIPPED";

export type TaskQueueMetricEvent = {
  name: TaskQueueMetricName;
  ts: number;
  taskId?: string;
  reason?: string;
};

export type TaskQueueMetrics = {
  counts: Record<TaskQueueMetricName, number>;
  events: TaskQueueMetricEvent[];
};

export type TaskQueueContext = {
  workspaceRoot: string;
  sessionId: string;
  lock: AsyncLock;
  taskStore: QueueTaskStore;
  attachmentStore: AttachmentStore;
  taskQueue: TaskQueue;
  reviewStore: ReviewStore;
  queueAutoStart: boolean;
  queueRunning: boolean;
  dequeueInProgress: boolean;
  metrics: TaskQueueMetrics;
  runController: TaskRunController;
  getStatusOrchestrator: () => ReturnType<SessionManager["getOrCreate"]>;
  getTaskQueueOrchestrator: (task: { id: string }) => ReturnType<SessionManager["getOrCreate"]>;
};

type ChangedPathsContext = { paths?: unknown };
type TaskWorkspacePatchArtifact = { paths: string[]; patch: WorkspacePatchPayload | null; reason?: string; createdAt: number };

const WebReviewVerdictSchema = z.object({
  verdict: z.enum(["passed", "rejected"]),
  conclusion: z.string().min(1),
}).passthrough();

type WebReviewVerdict = z.infer<typeof WebReviewVerdictSchema>;

function parseWebReviewVerdict(rawResponse: string): { ok: true; verdict: WebReviewVerdict } | { ok: false; error: string } {
  const payload = extractJsonPayload(rawResponse) ?? rawResponse;
  try {
    const parsed = JSON.parse(payload) as unknown;
    const verdict = WebReviewVerdictSchema.parse(parsed);
    return { ok: true, verdict };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, error: msg };
  }
}

function recordTaskWorkspacePatchArtifact(ctx: TaskQueueContext, taskId: string, now = Date.now()): void {
  const id = String(taskId ?? "").trim();
  if (!id) return;

  let contexts: ReturnType<QueueTaskStore["getContext"]> = [];
  try {
    contexts = ctx.taskStore.getContext(id);
  } catch {
    contexts = [];
  }
  if (contexts.some((c) => c.contextType === "artifact:workspace_patch")) {
    return;
  }

  const changedCtx = (() => {
    for (let i = contexts.length - 1; i >= 0; i--) {
      const c = contexts[i];
      if (c && c.contextType === "artifact:changed_paths") return c;
    }
    return null;
  })();

  const parsed = changedCtx ? safeParseJson<ChangedPathsContext>(changedCtx.content) : null;
  const paths = Array.isArray(parsed?.paths) ? (parsed?.paths as unknown[]).map((p) => String(p ?? "").trim()).filter(Boolean) : [];

  let patch: WorkspacePatchPayload | null = null;
  let reason = "";
  if (paths.length === 0) {
    reason = "no_changed_paths_recorded";
  } else {
    try {
      patch = buildWorkspacePatch(ctx.workspaceRoot, paths);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reason = `patch_error:${message}`;
    }
    if (!patch && !reason) {
      reason = "patch_not_available";
    }
  }

  const artifact: TaskWorkspacePatchArtifact = { paths, patch, reason: reason || undefined, createdAt: now };
  try {
    ctx.taskStore.saveContext(id, { contextType: "artifact:workspace_patch", content: JSON.stringify(artifact), createdAt: now }, now);
  } catch {
    // ignore
  }
}

function createTaskQueueMetrics(): TaskQueueMetrics {
  const names: TaskQueueMetricName[] = [
    "TASK_ADDED",
    "TASK_STARTED",
    "PROMPT_INJECTED",
    "TASK_COMPLETED",
    "INJECTION_SKIPPED",
  ];
  return {
    counts: Object.fromEntries(names.map((name) => [name, 0])) as Record<TaskQueueMetricName, number>,
    events: [],
  };
}

export function recordTaskQueueMetric(
  metrics: TaskQueueMetrics,
  name: TaskQueueMetricName,
  event?: { ts?: number; taskId?: string; reason?: string },
): void {
  metrics.counts[name] = (metrics.counts[name] ?? 0) + 1;
  metrics.events.push({
    name,
    ts: typeof event?.ts === "number" ? event.ts : Date.now(),
    taskId: event?.taskId,
    reason: event?.reason,
  });
  const maxEvents = 200;
  if (metrics.events.length > maxEvents) {
    metrics.events.splice(0, metrics.events.length - maxEvents);
  }
}

function hashTaskId(taskId: string): number {
  const normalized = String(taskId ?? "").trim();
  if (!normalized) return 0;
  const compact = normalized.replace(/-/g, "");
  const hex = compact.slice(0, 8);
  const parsed = Number.parseInt(hex, 16);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  let hash = 2166136261;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function createTaskQueueManager(deps: {
  workspaceRoot: string;
  allowedDirs: string[];
  adsStateDir: string;
  lockForWorkspace: (workspaceRoot: string) => AsyncLock;
  available: boolean;
  autoStart: boolean;
  logger: Logger;
  broadcastToSession: (sessionId: string, payload: unknown) => void;
  recordToSessionHistories: (sessionId: string, entry: { role: string; text: string; ts: number; kind?: string }) => void;
  reviewSessionManager?: SessionManager;
  broadcastToReviewerSession?: (sessionId: string, payload: unknown) => void;
  recordToReviewerHistories?: (sessionId: string, entry: { role: string; text: string; ts: number; kind?: string }) => void;
}): {
  ensureTaskContext: (workspaceRootForContext: string) => TaskQueueContext;
  resolveTaskWorkspaceRoot: (url: URL) => string;
  resolveTaskContext: (url: URL) => TaskQueueContext;
  promoteQueuedTasksToPending: (ctx: TaskQueueContext) => void;
} {
  const taskContexts = new Map<string, TaskQueueContext>();
  const allowedDirValidator = new DirectoryManager(deps.allowedDirs);

  const promoteQueuedTasksToPending = (ctx: TaskQueueContext): void => {
    if (!ctx.queueRunning) {
      return;
    }
    if (ctx.dequeueInProgress) {
      return;
    }
    ctx.dequeueInProgress = true;
    try {
      if (!ctx.queueRunning) {
        return;
      }
      if (ctx.taskStore.getActiveTaskId()) {
        return;
      }

      const now = Date.now();
      let promoted = 0;
      while (true) {
        const dequeued = ctx.taskStore.dequeueNextQueuedTask(now);
        if (!dequeued) {
          break;
        }
        promoted += 1;
        deps.broadcastToSession(ctx.sessionId, { type: "task:event", event: "task:updated", data: dequeued, ts: now });
      }
      if (promoted > 0) {
        ctx.taskQueue.notifyNewTask();
      }
    } finally {
      ctx.dequeueInProgress = false;
    }
  };

  const ensureTaskContext = (workspaceRootForContext: string): TaskQueueContext => {
    const key = String(workspaceRootForContext ?? "").trim() || deps.workspaceRoot;
    const existing = taskContexts.get(key);
    if (existing) {
      return existing;
    }

    const lock = deps.lockForWorkspace(key);
    const sessionId = deriveProjectSessionId(key);
    const taskStore = new QueueTaskStore({ workspacePath: key });
    const attachmentStore = new AttachmentStore({ workspacePath: key });
    const reviewStore = new ReviewStore({ workspacePath: key });

    const taskQueueStatusUserId = 0;
    const taskQueueModelOverride = String(process.env.TASK_QUEUE_DEFAULT_MODEL ?? "").trim() || undefined;
    const taskQueueThreadStorage = new ThreadStorage({
      namespace: `task-queue:${sessionId}`,
      storagePath: path.join(deps.adsStateDir, `task-queue-threads-${sessionId}.json`),
    });
    const taskQueueSessionManager = new SessionManager(
      0,
      0,
      "danger-full-access",
      taskQueueModelOverride,
      taskQueueThreadStorage,
    );
    const getStatusOrchestrator = () => taskQueueSessionManager.getOrCreate(taskQueueStatusUserId, key, true);
    const getTaskQueueOrchestrator = (task: { id: string }) => {
      const userId = hashTaskId(task.id);
      return taskQueueSessionManager.getOrCreate(userId, key, true);
    };

    const executor = new OrchestratorTaskExecutor({
      getOrchestrator: getTaskQueueOrchestrator,
      store: taskStore,
      autoModelOverride: taskQueueModelOverride,
      lock,
    });
    const taskQueue = new TaskQueue({ store: taskStore, executor });

    const ctx: TaskQueueContext = {
      workspaceRoot: key,
      sessionId,
      lock,
      taskStore,
      attachmentStore,
      taskQueue,
      reviewStore,
      queueAutoStart: deps.autoStart,
      queueRunning: false,
      dequeueInProgress: false,
      metrics: createTaskQueueMetrics(),
      runController: new TaskRunController(),
      getStatusOrchestrator,
      getTaskQueueOrchestrator,
    };
    taskContexts.set(key, ctx);

    let reviewLoopRunning = false;

    const reviewerEnabled = Boolean(deps.reviewSessionManager);

    const buildReviewerPrompt = (task: { id: string; title: string; prompt: string }, snapshot: { patch: WorkspacePatchPayload | null; changedFiles: string[] }): string => {
      const changedFiles = Array.isArray(snapshot.changedFiles) ? snapshot.changedFiles : [];
      const patchDiff = snapshot.patch?.diff ? String(snapshot.patch.diff) : "";
      const patchTruncated = Boolean(snapshot.patch?.truncated);
      const parts: string[] = [];
      parts.push("You are a strict code reviewer.");
      parts.push("You MUST base your review only on the immutable snapshot below (changed files list + diff patch + summaries).");
      parts.push("Do NOT run any tools. Do NOT assume current repository state. Do NOT ask questions.");
      parts.push("");
      parts.push("Task:");
      parts.push(`- taskId: ${task.id}`);
      parts.push(`- title: ${String(task.title ?? "").trim() || "(empty)"}`);
      parts.push("");
      parts.push("Goal (original prompt):");
      parts.push(String(task.prompt ?? "").trim() || "(empty)");
      parts.push("");
      parts.push("Snapshot:");
      parts.push(`- Diff truncated: ${patchTruncated ? "yes" : "no"}`);
      parts.push("");
      parts.push("Changed files:");
      if (changedFiles.length === 0) {
        parts.push("- (none)");
      } else {
        for (const file of changedFiles.slice(0, 200)) {
          parts.push(`- ${file}`);
        }
        if (changedFiles.length > 200) {
          parts.push(`- ... (${changedFiles.length - 200} more)`);
        }
      }
      parts.push("");
      parts.push("Diff:");
      parts.push("```diff");
      parts.push(patchDiff.trimEnd().slice(0, 200_000));
      parts.push("```");
      parts.push("");
      parts.push("Output:");
      parts.push('Return ONLY a single JSON object: {"verdict":"passed|rejected","conclusion":"..."}');
      parts.push("Do not wrap in markdown. No extra keys are required.");
      return parts.join("\n").trim() + "\n";
    };

    const runReviewLoop = async (): Promise<void> => {
      if (!reviewerEnabled) {
        return;
      }
      if (reviewLoopRunning) {
        return;
      }
      reviewLoopRunning = true;

      try {
        while (true) {
          const now = Date.now();
          const item = ctx.reviewStore.claimNextPending(now);
          if (!item) {
            return;
          }

          const reviewerSessionManager = deps.reviewSessionManager!;
          const reviewUserId = hashTaskId(`review:${item.id}`);

          const task = ctx.taskStore.getTask(item.taskId);
          if (!task) {
            ctx.reviewStore.completeItem(item.id, { status: "failed", error: "task_not_found" }, now);
            continue;
          }

          let runningTask = task;
          if (task.reviewStatus !== "running") {
            try {
              runningTask = ctx.taskStore.updateTask(task.id, { reviewStatus: "running" }, now);
              deps.broadcastToSession(sessionId, { type: "task:event", event: "task:updated", data: runningTask, ts: now });
            } catch {
              // ignore
            }
          }

          const snapshot = ctx.reviewStore.getSnapshot(item.snapshotId);
          if (!snapshot) {
            ctx.reviewStore.completeItem(item.id, { status: "failed", error: "snapshot_not_found" }, now);
            try {
              const reverted = ctx.taskStore.updateTask(task.id, { reviewStatus: "pending" }, now);
              deps.broadcastToSession(sessionId, { type: "task:event", event: "task:updated", data: reverted, ts: now });
            } catch {
              // ignore
            }
            continue;
          }

          const prompt = buildReviewerPrompt(
            { id: runningTask.id, title: runningTask.title, prompt: runningTask.prompt },
            { patch: snapshot.patch, changedFiles: snapshot.changedFiles },
          );

          let responseText = "";
          try {
            reviewerSessionManager.dropSession(reviewUserId, { clearSavedThread: true });
          } catch {
            // ignore
          }
          try {
            const orchestrator = reviewerSessionManager.getOrCreate(reviewUserId, ctx.workspaceRoot, false);
            orchestrator.setWorkingDirectory(ctx.workspaceRoot);
            const status = orchestrator.status();
            if (!status.ready) {
              throw new Error(status.error ?? "reviewer agent not ready");
            }
            const agentId = orchestrator.getActiveAgentId();
            const result = await orchestrator.invokeAgent(agentId, prompt, { streaming: false });
            responseText =
              typeof (result as { response?: unknown } | null)?.response === "string"
                ? (result as { response: string }).response
                : String((result as { response?: unknown } | null)?.response ?? "");
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            ctx.reviewStore.completeItem(item.id, { status: "failed", error: message }, Date.now());
            try {
              const reverted = ctx.taskStore.updateTask(task.id, { reviewStatus: "pending" }, Date.now());
              deps.broadcastToSession(sessionId, { type: "task:event", event: "task:updated", data: reverted, ts: Date.now() });
            } catch {
              // ignore
            }
            deps.broadcastToReviewerSession?.(sessionId, {
              type: "error",
              message: `[Review failed] taskId=${task.id} snapshotId=${item.snapshotId} err=${message}`,
            });
            continue;
          } finally {
            try {
              reviewerSessionManager.dropSession(reviewUserId, { clearSavedThread: true });
            } catch {
              // ignore
            }
          }

          const parsed = parseWebReviewVerdict(responseText);
          if (!parsed.ok) {
            const errorMessage = `invalid_review_verdict_json:${parsed.error}`;
            ctx.reviewStore.completeItem(item.id, { status: "failed", error: errorMessage }, Date.now());
            try {
              const reverted = ctx.taskStore.updateTask(task.id, { reviewStatus: "pending" }, Date.now());
              deps.broadcastToSession(sessionId, { type: "task:event", event: "task:updated", data: reverted, ts: Date.now() });
            } catch {
              // ignore
            }
            deps.broadcastToReviewerSession?.(sessionId, {
              type: "error",
              message: `[Review failed] taskId=${task.id} snapshotId=${item.snapshotId} err=${errorMessage}`,
            });
            continue;
          }

          const verdict = parsed.verdict;
          const verdictStatus = verdict.verdict;
          const conclusion = verdict.conclusion.trim();

          ctx.reviewStore.completeItem(item.id, { status: verdictStatus, conclusion }, Date.now());

          let updatedTask = runningTask;
          try {
            updatedTask = ctx.taskStore.updateTask(
              runningTask.id,
              { reviewStatus: verdictStatus, reviewConclusion: conclusion, reviewedAt: Date.now() },
              Date.now(),
            );
          } catch {
            // ignore
          }

          deps.broadcastToSession(sessionId, { type: "task:event", event: "task:updated", data: updatedTask, ts: Date.now() });

          const reviewSummary = `[Review ${verdictStatus.toUpperCase()}] taskId=${updatedTask.id} snapshotId=${item.snapshotId}\n\n${conclusion}`;
          deps.broadcastToReviewerSession?.(sessionId, { type: "result", ok: true, output: reviewSummary, kind: "review" });
          deps.recordToReviewerHistories?.(sessionId, { role: "ai", text: reviewSummary, ts: Date.now(), kind: "review" });
        }
      } finally {
        reviewLoopRunning = false;
      }
    };

    const ensureReviewEnqueued = (taskId: string, now = Date.now()): void => {
      if (!reviewerEnabled) {
        return;
      }
      const task = ctx.taskStore.getTask(taskId);
      if (!task || !task.reviewRequired) {
        return;
      }
      if (task.reviewStatus === "passed" || task.reviewStatus === "rejected") {
        return;
      }

      const existingSnapshotId = String(task.reviewSnapshotId ?? "").trim();
      if (existingSnapshotId) {
        const open = ctx.reviewStore.getOpenQueueItemBySnapshotId(existingSnapshotId);
        if (!open) {
          ctx.reviewStore.enqueueReview({ taskId: task.id, snapshotId: existingSnapshotId }, now);
        }
        void runReviewLoop();
        return;
      }

      let patchArtifact: TaskWorkspacePatchArtifact | null = null;
      let changedFiles: string[] = [];
      try {
        const contexts = ctx.taskStore.getContext(taskId);
        const latestPatch = [...contexts].reverse().find((c) => c.contextType === "artifact:workspace_patch") ?? null;
        patchArtifact = latestPatch ? safeParseJson<TaskWorkspacePatchArtifact>(latestPatch.content) : null;
        const latestChanged = [...contexts].reverse().find((c) => c.contextType === "artifact:changed_paths") ?? null;
        const changedParsed = latestChanged ? safeParseJson<ChangedPathsContext>(latestChanged.content) : null;
        changedFiles = Array.isArray(changedParsed?.paths)
          ? (changedParsed?.paths as unknown[]).map((p) => String(p ?? "").trim()).filter(Boolean)
          : [];
      } catch {
        patchArtifact = null;
        changedFiles = [];
      }

      const snapshot = ctx.reviewStore.createSnapshot(
        {
          taskId: task.id,
          specRef: null,
          patch: patchArtifact?.patch ?? null,
          changedFiles: patchArtifact?.paths?.length ? patchArtifact.paths : changedFiles,
          lintSummary: "",
          testSummary: "",
        },
        now,
      );

      const pendingTask = ctx.taskStore.updateTask(task.id, { reviewStatus: "pending", reviewSnapshotId: snapshot.id }, now);
      deps.broadcastToSession(sessionId, { type: "task:event", event: "task:updated", data: pendingTask, ts: now });

      const open = ctx.reviewStore.getOpenQueueItemBySnapshotId(snapshot.id);
      if (!open) {
        ctx.reviewStore.enqueueReview({ taskId: task.id, snapshotId: snapshot.id }, now);
      }

      void runReviewLoop();
    };

    taskQueue.on("task:started", ({ task }) => {
      const ts = Date.now();
      recordTaskQueueMetric(ctx.metrics, "TASK_STARTED", { ts, taskId: task.id });
      const prompt = String((task as { prompt?: unknown } | null)?.prompt ?? "").trim();
      if (!prompt) {
        deps.logger.warn(`[Web] task prompt is empty; broadcasting placeholder taskId=${task.id}`);
      }
      broadcastTaskStart({
        task,
        ts,
        markPromptInjected: (taskId: string, now: number) => {
          try {
            return ctx.taskStore.markPromptInjected(taskId, now);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            deps.logger.warn(`[Web] markPromptInjected failed taskId=${taskId} err=${message}`);
            throw error;
          }
        },
        recordHistory: (entry) => deps.recordToSessionHistories(ctx.sessionId, entry),
        recordMetric: (name, event) => recordTaskQueueMetric(ctx.metrics, name, event),
        broadcast: (payload) => deps.broadcastToSession(sessionId, payload),
      });
    });
    taskQueue.on("task:running", ({ task }) =>
      deps.broadcastToSession(sessionId, { type: "task:event", event: "task:running", data: task, ts: Date.now() }),
    );
    taskQueue.on("message", ({ task, role, content }) =>
      deps.broadcastToSession(sessionId, { type: "task:event", event: "message", data: { taskId: task.id, role, content }, ts: Date.now() }),
    );
    taskQueue.on("message:delta", ({ task, role, delta, modelUsed, source }) =>
      deps.broadcastToSession(sessionId, {
        type: "task:event",
        event: "message:delta",
        data: { taskId: task.id, role, delta, modelUsed, source },
        ts: Date.now(),
      }),
    );
    taskQueue.on("command", ({ task, command }) => {
      deps.broadcastToSession(sessionId, { type: "task:event", event: "command", data: { taskId: task.id, command }, ts: Date.now() });
      deps.recordToSessionHistories(sessionId, { role: "status", text: `$ ${command}`, ts: Date.now(), kind: "command" });
    });
    taskQueue.on("task:completed", ({ task }) => {
      recordTaskQueueMetric(ctx.metrics, "TASK_COMPLETED", { ts: Date.now(), taskId: task.id });
      recordTaskWorkspacePatchArtifact(ctx, task.id);
      deps.broadcastToSession(sessionId, { type: "task:event", event: "task:completed", data: task, ts: Date.now() });
      if (task.result && task.result.trim()) {
        deps.recordToSessionHistories(sessionId, { role: "ai", text: task.result.trim(), ts: Date.now() });
      }
      if (task.reviewRequired) {
        try {
          ensureReviewEnqueued(task.id);
        } catch {
          // ignore
        }
      }
      try {
        notifyTaskTerminalViaTelegram({ logger: deps.logger, workspaceRoot: ctx.workspaceRoot, task, terminalStatus: "completed" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.logger.warn(`[Web][TaskNotifications] terminal notify hook failed taskId=${task.id} err=${message}`);
      }
      if (ctx.runController.onTaskTerminal(ctx, task.id)) {
        return;
      }
      promoteQueuedTasksToPending(ctx);
      ctx.runController.maybePauseAfterDrain(ctx);
    });
    taskQueue.on("task:failed", ({ task, error }) => {
      deps.broadcastToSession(sessionId, { type: "task:event", event: "task:failed", data: { task, error }, ts: Date.now() });
      deps.recordToSessionHistories(sessionId, { role: "status", text: `[Task failed] ${error}`, ts: Date.now(), kind: "error" });
      if (task.status === "failed") {
        recordTaskQueueMetric(ctx.metrics, "TASK_COMPLETED", { ts: Date.now(), taskId: task.id });
        recordTaskWorkspacePatchArtifact(ctx, task.id);
        try {
          notifyTaskTerminalViaTelegram({ logger: deps.logger, workspaceRoot: ctx.workspaceRoot, task, terminalStatus: "failed" });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          deps.logger.warn(`[Web][TaskNotifications] terminal notify hook failed taskId=${task.id} err=${message}`);
        }
        if (ctx.runController.onTaskTerminal(ctx, task.id)) {
          return;
        }
        promoteQueuedTasksToPending(ctx);
        ctx.runController.maybePauseAfterDrain(ctx);
      }
    });
    taskQueue.on("task:cancelled", ({ task }) => {
      deps.broadcastToSession(sessionId, { type: "task:event", event: "task:cancelled", data: task, ts: Date.now() });
      deps.recordToSessionHistories(sessionId, { role: "status", text: "[Cancelled]", ts: Date.now(), kind: "status" });
      recordTaskQueueMetric(ctx.metrics, "TASK_COMPLETED", { ts: Date.now(), taskId: task.id });
      recordTaskWorkspacePatchArtifact(ctx, task.id);
      try {
        notifyTaskTerminalViaTelegram({ logger: deps.logger, workspaceRoot: ctx.workspaceRoot, task, terminalStatus: "cancelled" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.logger.warn(`[Web][TaskNotifications] terminal notify hook failed taskId=${task.id} err=${message}`);
      }
      if (ctx.runController.onTaskTerminal(ctx, task.id)) {
        return;
      }
      promoteQueuedTasksToPending(ctx);
      ctx.runController.maybePauseAfterDrain(ctx);
    });

    // Best-effort: start draining pending review items when context is first created.
    void runReviewLoop();

    if (deps.available) {
      const status = getStatusOrchestrator().status();
      if (deps.autoStart) {
        ctx.runController.setModeAll();
        void taskQueue.start();
        ctx.queueRunning = true;
        deps.logger.info(`[Web] TaskQueue started workspace=${key}`);
        promoteQueuedTasksToPending(ctx);
      } else {
        ctx.runController.setModeManual();
        taskQueue.pause("manual");
        void taskQueue.start();
        ctx.queueRunning = false;
        deps.logger.info(`[Web] TaskQueue paused workspace=${key}`);
      }
      if (!status.ready) {
        deps.logger.warn(`[Web] Agent not ready yet; tasks may fail: ${status.error ?? "unknown"}`);
      }
    }

    return ctx;
  };

  const resolveTaskWorkspaceRoot = (url: URL): string => {
    const rawWorkspace = String(url.searchParams.get("workspace") ?? "").trim();
    if (!rawWorkspace) {
      return deps.workspaceRoot;
    }

    const absolute = path.resolve(rawWorkspace);
    let resolved = absolute;
    try {
      resolved = fs.realpathSync(absolute);
    } catch {
      resolved = absolute;
    }

    if (!fs.existsSync(resolved)) {
      throw new Error(`Workspace does not exist: ${resolved}`);
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      throw new Error(`Workspace not accessible: ${resolved}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Workspace is not a directory: ${resolved}`);
    }

    const workspaceRootCandidate = detectWorkspaceFrom(resolved);
    let normalizedWorkspaceRoot = workspaceRootCandidate;
    try {
      normalizedWorkspaceRoot = fs.realpathSync(workspaceRootCandidate);
    } catch {
      normalizedWorkspaceRoot = workspaceRootCandidate;
    }

    if (!fs.existsSync(normalizedWorkspaceRoot)) {
      throw new Error(`Workspace root does not exist: ${normalizedWorkspaceRoot}`);
    }
    try {
      if (!fs.statSync(normalizedWorkspaceRoot).isDirectory()) {
        throw new Error(`Workspace root is not a directory: ${normalizedWorkspaceRoot}`);
      }
    } catch {
      throw new Error(`Workspace root not accessible: ${normalizedWorkspaceRoot}`);
    }

    if (!allowedDirValidator.validatePath(normalizedWorkspaceRoot)) {
      throw new Error("Workspace is not allowed");
    }

    return normalizedWorkspaceRoot;
  };

  const resolveTaskContext = (url: URL): TaskQueueContext => {
    const targetWorkspaceRoot = resolveTaskWorkspaceRoot(url);
    return ensureTaskContext(targetWorkspaceRoot);
  };

  return {
    ensureTaskContext,
    resolveTaskWorkspaceRoot,
    resolveTaskContext,
    promoteQueuedTasksToPending,
  };
}
