export type TaskStatus =
  | "queued"
  | "pending"
  | "planning"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskRole = "system" | "user" | "assistant" | "tool";

export type TaskReviewStatus = "none" | "pending" | "running" | "passed" | "rejected" | "failed";
export type TaskExecutionIsolation = "default" | "required";
export type TaskRunStatus = "preparing" | "running" | "completed" | "failed" | "cancelled";
export type TaskRunCaptureStatus = "pending" | "ok" | "failed" | "skipped";
export type TaskRunApplyStatus = "pending" | "applied" | "blocked" | "failed" | "skipped";

export interface TaskContext {
  id?: number;
  taskId: string;
  contextType: string;
  content: string;
  createdAt: number;
}

export type ConversationStatus = "active" | "archived";

export interface Conversation {
  id: string;
  taskId?: string | null;
  title?: string | null;
  totalTokens: number;
  lastModel?: string | null;
  modelResponseIds?: Record<string, string> | null;
  status: ConversationStatus;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationMessage {
  id?: number;
  conversationId: string;
  taskId?: string | null;
  role: TaskRole;
  content: string;
  modelId?: string | null;
  tokenCount?: number | null;
  metadata?: Record<string, unknown> | null;
  createdAt: number;
}

export interface Task {
  id: string;
  title: string;
  prompt: string;
  model: string;
  modelParams?: Record<string, unknown> | null;
  status: TaskStatus;
  priority: number;
  queueOrder: number;
  queuedAt?: number | null;
  promptInjectedAt?: number | null;
  inheritContext: boolean;
  agentId: string | null;
  parentTaskId?: string | null;
  threadId?: string | null;
  result?: string | null;
  error?: string | null;
  retryCount: number;
  maxRetries: number;
  executionIsolation?: TaskExecutionIsolation;
  reviewRequired: boolean;
  reviewStatus: TaskReviewStatus;
  reviewSnapshotId?: string | null;
  reviewConclusion?: string | null;
  reviewedAt?: number | null;
  createdAt: number;
  startedAt?: number | null;
  completedAt?: number | null;
  archivedAt?: number | null;
  createdBy?: string | null;
  latestRun?: TaskRun | null;
}

export interface CreateTaskInput {
  id?: string;
  title?: string;
  prompt: string;
  model?: string;
  modelParams?: Record<string, unknown> | null;
  priority?: number;
  inheritContext?: boolean;
  agentId?: string | null;
  parentTaskId?: string | null;
  threadId?: string | null;
  maxRetries?: number;
  executionIsolation?: TaskExecutionIsolation;
  reviewRequired?: boolean;
  createdBy?: string | null;
}

export interface TaskRun {
  id: string;
  taskId: string;
  executionIsolation: TaskExecutionIsolation;
  workspaceRoot: string;
  worktreeDir: string | null;
  branchName: string | null;
  baseHead: string | null;
  endHead: string | null;
  status: TaskRunStatus;
  captureStatus: TaskRunCaptureStatus;
  applyStatus: TaskRunApplyStatus;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

export interface CreateTaskRunInput {
  id?: string;
  taskId: string;
  executionIsolation: TaskExecutionIsolation;
  workspaceRoot: string;
  worktreeDir?: string | null;
  branchName?: string | null;
  baseHead?: string | null;
  endHead?: string | null;
  status?: TaskRunStatus;
  captureStatus?: TaskRunCaptureStatus;
  applyStatus?: TaskRunApplyStatus;
  error?: string | null;
}

export interface TaskFilter {
  status?: TaskStatus;
  limit?: number;
}

export interface TaskMessage {
  id?: number;
  taskId: string;
  planStepId?: number | null;
  role: TaskRole;
  content: string;
  messageType?: string | null;
  modelUsed?: string | null;
  tokenCount?: number | null;
  createdAt: number;
}

export interface ModelConfig {
  id: string;
  displayName: string;
  provider: string;
  isEnabled: boolean;
  isDefault: boolean;
  configJson?: Record<string, unknown> | null;
  updatedAt?: number | null;
}
