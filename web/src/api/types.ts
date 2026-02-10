export type TaskStatus =
  | "queued"
  | "pending"
  | "planning"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export interface Task {
  id: string;
  title: string;
  prompt: string;
  model: string;
  status: TaskStatus;
  priority: number;
  queueOrder: number;
  queuedAt?: number | null;
  promptInjectedAt?: number | null;
  inheritContext: boolean;
  result?: string | null;
  error?: string | null;
  retryCount: number;
  maxRetries: number;
  createdAt: number;
  startedAt?: number | null;
  completedAt?: number | null;
  archivedAt?: number | null;
  createdBy?: string | null;
  attachments?: Attachment[];
}

export interface TaskMessage {
  id: number;
  taskId: string;
  planStepId?: number | null;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  messageType?: string | null;
  modelUsed?: string | null;
  tokenCount?: number | null;
  createdAt: number;
}

export interface TaskDetail extends Task {
  messages: TaskMessage[];
}

export interface Attachment {
  id: string;
  url: string;
  sha256: string;
  width: number;
  height: number;
  contentType: string;
  sizeBytes: number;
  filename?: string | null;
}

export interface Prompt {
  id: string;
  name: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

export interface BootstrapConfig {
  enabled: boolean;
  projectRef: string;
  maxIterations?: number;
  softSandbox?: boolean;
}

export interface CreateTaskInput {
  title?: string;
  prompt: string;
  model?: string;
  priority?: number;
  inheritContext?: boolean;
  maxRetries?: number;
  attachments?: string[];
  bootstrap?: BootstrapConfig;
}

export interface ModelConfig {
  id: string;
  displayName: string;
  provider: string;
  isEnabled: boolean;
  isDefault: boolean;
}

export interface TaskQueueStatus {
  enabled: boolean;
  running: boolean;
  ready: boolean;
  streaming: boolean;
  error?: string;
}

export type TaskEventPayload =
  | { event: "task:started"; data: Task }
  | { event: "task:updated"; data: Task }
  | { event: "task:deleted"; data: { taskId: string } }
  | { event: "task:running"; data: Task }
  | { event: "task:completed"; data: Task }
  | { event: "task:cancelled"; data: Task }
  | { event: "task:failed"; data: { task: Task; error: string } }
  | { event: "message"; data: { taskId: string; role: string; content: string } }
  | { event: "message:delta"; data: { taskId: string; role: string; delta: string; modelUsed?: string | null; source?: "chat" | "step" } }
  | { event: "command"; data: { taskId: string; command: string } };

export type TaskBundleTask = {
  externalId?: string;
  title?: string;
  prompt: string;
  model?: string;
  priority?: number;
  inheritContext?: boolean;
  maxRetries?: number;
  attachments?: string[];
};

export type TaskBundle = {
  version: 1;
  requestId?: string;
  runQueue?: boolean;
  insertPosition?: "front" | "back";
  tasks: TaskBundleTask[];
};

export type TaskBundleDraftStatus = "draft" | "approved" | "deleted";

export type TaskBundleDraft = {
  id: string;
  workspaceRoot: string;
  requestId: string | null;
  status: TaskBundleDraftStatus;
  bundle: TaskBundle | null;
  createdAt: number;
  updatedAt: number;
  approvedAt: number | null;
  approvedTaskIds: string[];
  lastError: string | null;
};
