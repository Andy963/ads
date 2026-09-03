export type TaskStatus =
  | "queued"
  | "pending"
  | "planning"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
  | "complete";

export type TaskRole = "system" | "user" | "assistant" | "tool";

export type TaskExecutionIsolation = "default" | "required";
export type TaskCategory = "development" | "review" | "rework";
export type TaskReviewStatus =
  | "none"
  | "pending_review"
  | "in_review"
  | "approved"
  | "rejected"
  | "skipped"
  | "needs_human_intervention"
  | "error";
export type ReviewAutomationMode = "auto_with_fuse" | "human_gated";
export type ReviewControlState = "automatic" | "human_gated" | "needs_intervention";
export type TaskRunStatus = "preparing" | "running" | "completed" | "failed" | "cancelled";
export type TaskRunCaptureStatus = "pending" | "ok" | "failed" | "skipped";
export type TaskRunApplyStatus = "pending" | "applied" | "blocked" | "failed" | "skipped";
export type TaskRunCleanupStatus = "pending" | "cleaned" | "failed" | "not_required";

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

export interface TaskReviewSummary {
  required: boolean;
  status: TaskReviewStatus;
  rootTaskId: string | null;
  pullRequestNumber: number | null;
  pullRequestUrl: string | null;
  reviewTaskId: string | null;
  reviewerModelConfigId: string | null;
  reviewerModelId: string | null;
  reviewerModelDisplayName: string | null;
  reviewerAgentId: string | null;
  reviewStartedAt: number | null;
  reviewedAt: number | null;
  conclusion: string | null;
  feedback: string | null;
  output: string | null;
  artifactId: string | null;
  reworkRound: number;
  maxReworkRounds: number;
  automationMode: ReviewAutomationMode;
  stateReason: string | null;
  reworkTaskIds: string[];
  controlState: ReviewControlState;
}

export interface ReviewSettings {
  automationMode: ReviewAutomationMode;
  maxReworkRounds: number;
  updatedAt: number | null;
}

export type ReviewAction = "force_approve" | "edit_rework" | "skip_review" | "abort";

export interface ReviewActionAudit {
  id: string;
  taskId: string;
  rootTaskId: string;
  action: ReviewAction;
  reason: string | null;
  actorId: string;
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
  category: TaskCategory;
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
  nextAttemptAt?: number | null;
  executionIsolation?: TaskExecutionIsolation;
  createdAt: number;
  startedAt?: number | null;
  completedAt?: number | null;
  archivedAt?: number | null;
  createdBy?: string | null;
  goalMode: boolean;
  goalObjective?: string | null;
  goalTokenBudget?: number | null;
  goalStatus?: TaskGoalStatus | null;
  goalTokensUsed?: number | null;
  goalTimeUsedSeconds?: number | null;
  review?: TaskReviewSummary;
  latestRun?: TaskRun | null;
}

export interface CreateTaskInput {
  id?: string;
  title?: string;
  prompt: string;
  model?: string;
  modelParams?: Record<string, unknown> | null;
  priority?: number;
  category?: TaskCategory;
  inheritContext?: boolean;
  agentId?: string | null;
  parentTaskId?: string | null;
  threadId?: string | null;
  maxRetries?: number;
  executionIsolation?: TaskExecutionIsolation;
  createdBy?: string | null;
  goalMode?: boolean;
  goalObjective?: string | null;
  goalTokenBudget?: number | null;
  review?: Partial<TaskReviewSummary>;
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
  cleanupStatus: TaskRunCleanupStatus;
  cleanupError: string | null;
  cleanupAt: number | null;
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
  cleanupStatus?: TaskRunCleanupStatus;
  cleanupError?: string | null;
  cleanupAt?: number | null;
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
  modelId?: string | null;
  displayName: string;
  provider: string;
  isEnabled: boolean;
  isDefault: boolean;
  configJson?: Record<string, unknown> | null;
  updatedAt?: number | null;
}

export type ReviewerModelSelection = {
  model: string;
  agentId: string;
  modelConfigId?: string;
  modelId?: string;
  displayName?: string;
};
