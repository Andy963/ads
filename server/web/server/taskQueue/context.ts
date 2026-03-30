import path from "node:path";

import { ThreadStorage } from "../../../telegram/utils/threadStorage.js";
import { SessionManager, resolveSessionAgentAllowlist } from "../../../telegram/utils/sessionManager.js";
import { AttachmentStore } from "../../../attachments/store.js";
import { OrchestratorTaskExecutor } from "../../../tasks/executor.js";
import { TaskQueue } from "../../../tasks/queue.js";
import { ReviewStore } from "../../../tasks/reviewStore.js";
import { TaskStore as QueueTaskStore } from "../../../tasks/store.js";
import { TaskRunController } from "../../taskRunController.js";
import { deriveProjectSessionId } from "../projectSessionId.js";
import type { AsyncLock } from "../../../utils/asyncLock.js";
import type { TaskQueueContext } from "./types.js";
import {
  createTaskQueueMetrics,
  hashTaskId,
  resolveTaskQueueSessionCleanupIntervalMs,
  resolveTaskQueueSessionTimeoutMs,
} from "./metrics.js";

export function createTaskQueueContext(args: {
  workspaceRoot: string;
  adsStateDir: string;
  autoStart: boolean;
  lockForWorkspace: (workspaceRoot: string) => AsyncLock;
}): TaskQueueContext {
  const workspaceRoot = String(args.workspaceRoot ?? "").trim();
  const getLock = () => args.lockForWorkspace(workspaceRoot);
  const sessionId = deriveProjectSessionId(workspaceRoot);
  const taskStore = new QueueTaskStore({ workspacePath: workspaceRoot });
  const attachmentStore = new AttachmentStore({ workspacePath: workspaceRoot });
  const reviewStore = new ReviewStore({ workspacePath: workspaceRoot });

  const taskQueueStatusUserId = 0;
  const taskQueueModelOverride = String(process.env.TASK_QUEUE_DEFAULT_MODEL ?? "").trim() || undefined;
  const taskQueueThreadStorage = new ThreadStorage({
    namespace: `task-queue:${sessionId}`,
    storagePath: path.join(args.adsStateDir, `task-queue-threads-${sessionId}.json`),
  });
  const taskQueueSessionManager = new SessionManager(
    resolveTaskQueueSessionTimeoutMs(),
    resolveTaskQueueSessionCleanupIntervalMs(),
    "danger-full-access",
    taskQueueModelOverride,
    taskQueueThreadStorage,
    undefined,
    {
      agentAllowlist: resolveSessionAgentAllowlist("task-queue"),
    },
  );
  const getStatusOrchestrator = () =>
    taskQueueSessionManager.getOrCreate(taskQueueStatusUserId, workspaceRoot, true);
  const getTaskQueueOrchestrator = (task: { id: string }) => {
    const userId = hashTaskId(task.id);
    return taskQueueSessionManager.getOrCreate(userId, workspaceRoot, true);
  };

  const executor = new OrchestratorTaskExecutor({
    getOrchestrator: getTaskQueueOrchestrator,
    store: taskStore,
    workspaceRoot,
    autoModelOverride: taskQueueModelOverride,
    getLock,
  });
  const taskQueue = new TaskQueue({ store: taskStore, executor });

  return {
    workspaceRoot,
    sessionId,
    getLock,
    taskStore,
    attachmentStore,
    taskQueue,
    reviewStore,
    queueAutoStart: args.autoStart,
    queueRunning: false,
    dequeueInProgress: false,
    metrics: createTaskQueueMetrics(),
    runController: new TaskRunController(),
    getStatusOrchestrator,
    getTaskQueueOrchestrator,
  };
}
