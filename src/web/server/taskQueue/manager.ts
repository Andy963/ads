import fs from "node:fs";
import path from "node:path";

import type { Logger } from "../../../utils/logger.js";
import { detectWorkspaceFrom } from "../../../workspace/detector.js";
import { DirectoryManager } from "../../../telegram/utils/directoryManager.js";
import { ThreadStorage } from "../../../telegram/utils/threadStorage.js";
import { SessionManager } from "../../../telegram/utils/sessionManager.js";
import { deriveProjectSessionId } from "../projectSessionId.js";

import { TaskQueue } from "../../../tasks/queue.js";
import { TaskStore as QueueTaskStore } from "../../../tasks/store.js";
import { OrchestratorTaskExecutor } from "../../../tasks/executor.js";
import { AttachmentStore } from "../../../attachments/store.js";
import { TaskRunController } from "../../taskRunController.js";
import { broadcastTaskStart } from "../../taskStartBroadcast.js";
import type { AsyncLock } from "../../../utils/asyncLock.js";
import { buildWorkspacePatch, type WorkspacePatchPayload } from "../../gitPatch.js";
import { notifyTaskTerminalViaTelegram } from "../../taskNotifications/telegramNotifier.js";

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
  queueRunning: boolean;
  dequeueInProgress: boolean;
  metrics: TaskQueueMetrics;
  runController: TaskRunController;
  getStatusOrchestrator: () => ReturnType<SessionManager["getOrCreate"]>;
  getTaskQueueOrchestrator: (task: { id: string }) => ReturnType<SessionManager["getOrCreate"]>;
};

type ChangedPathsContext = { paths?: unknown };
type TaskWorkspacePatchArtifact = { paths: string[]; patch: WorkspacePatchPayload | null; reason?: string; createdAt: number };

function safeJsonParse<T>(raw: string): T | null {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return null;
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

  const parsed = changedCtx ? safeJsonParse<ChangedPathsContext>(changedCtx.content) : null;
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

    const taskQueueStatusUserId = 0;
    const taskQueueThreadStorage = new ThreadStorage({
      namespace: `task-queue:${sessionId}`,
      storagePath: path.join(deps.adsStateDir, `task-queue-threads-${sessionId}.json`),
    });
    const taskQueueSessionManager = new SessionManager(
      0,
      0,
      "workspace-write",
      process.env.TASK_QUEUE_DEFAULT_MODEL,
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
      defaultModel: process.env.TASK_QUEUE_DEFAULT_MODEL ?? "gpt-5.2",
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
      queueRunning: false,
      dequeueInProgress: false,
      metrics: createTaskQueueMetrics(),
      runController: new TaskRunController(),
      getStatusOrchestrator,
      getTaskQueueOrchestrator,
    };
    taskContexts.set(key, ctx);

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
    });

    if (deps.available) {
      const status = getStatusOrchestrator().status();
      if (deps.autoStart) {
        void taskQueue.start();
        ctx.queueRunning = true;
        deps.logger.info(`[Web] TaskQueue started workspace=${key}`);
        promoteQueuedTasksToPending(ctx);
      } else {
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
