import type { AttachmentStore } from "../../../attachments/store.js";
import type { ReviewStore } from "../../../tasks/reviewStore.js";
import type { TaskQueue } from "../../../tasks/queue.js";
import type { TaskStore as QueueTaskStore } from "../../../tasks/store.js";
import type { AsyncLock } from "../../../utils/asyncLock.js";
import type { TaskRunController } from "../../taskRunController.js";
import type { SessionManager } from "../../../telegram/utils/sessionManager.js";

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
  getLock: () => AsyncLock;
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
