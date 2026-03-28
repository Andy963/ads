export type TaskStatus =
  | "queued"
  | "pending"
  | "planning"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskReviewStatus = "none" | "pending" | "running" | "passed" | "rejected" | "failed";
export type TaskExecutionIsolation = "default" | "required";
export type TaskRunStatus = "preparing" | "running" | "completed" | "failed" | "cancelled";
export type TaskRunCaptureStatus = "pending" | "ok" | "failed" | "skipped";
export type TaskRunApplyStatus = "pending" | "applied" | "blocked" | "failed" | "skipped";

export interface TaskRun {
  id: string;
  taskId: string;
  executionIsolation?: TaskExecutionIsolation;
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
  executionIsolation: TaskExecutionIsolation;
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
  attachments?: Attachment[];
  latestRun?: TaskRun | null;
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

export interface BootstrapConfig {
  enabled: boolean;
  projectRef: string;
  maxIterations?: number;
}

export interface CreateTaskInput {
  title?: string;
  prompt: string;
  agentId?: string | null;
  model?: string;
  priority?: number;
  maxRetries?: number;
  reviewRequired?: boolean;
  reviewArtifactId?: string;
  reviewSnapshotId?: string;
  execution?: {
    isolation?: TaskExecutionIsolation;
  };
  attachments?: string[];
  bootstrap?: BootstrapConfig;
}

export interface ModelConfig {
  id: string;
  displayName: string;
  provider: string;
  isEnabled: boolean;
  isDefault: boolean;
  configJson?: Record<string, unknown> | null;
}

export type FilePreviewResponse = {
  path: string;
  content: string;
  totalLines: number;
  startLine: number;
  endLine: number;
  truncated: boolean;
  language: string | null;
  line: number | null;
};

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

export type ReviewQueueItemStatus = "pending" | "running" | "passed" | "rejected" | "failed";

export type ReviewQueueItem = {
  id: string;
  taskId: string;
  snapshotId: string;
  status: ReviewQueueItemStatus;
  error: string | null;
  conclusion: string | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  taskTitle: string;
  taskStatus: TaskStatus | null;
  reviewRequired: boolean | null;
  reviewStatus: TaskReviewStatus | null;
  reviewConclusion: string | null;
};

export type ReviewQueueResponse = {
  items: ReviewQueueItem[];
};

export type ReviewSnapshotPatchFile = {
  path: string;
  added: number | null;
  removed: number | null;
};

export type ReviewSnapshotPatch = {
  files: ReviewSnapshotPatchFile[];
  diff: string;
  truncated?: boolean;
};

export type ReviewSnapshot = {
  id: string;
  taskId: string;
  taskRunId: string | null;
  executionIsolation: TaskExecutionIsolation;
  worktreeDir: string | null;
  branchName: string | null;
  baseHead: string | null;
  endHead: string | null;
  applyStatus: TaskRunApplyStatus | null;
  captureStatus: TaskRunCaptureStatus | null;
  specRef: string | null;
  worktreeDir: string;
  patch: ReviewSnapshotPatch | null;
  changedFiles: string[];
  lintSummary: string;
  testSummary: string;
  createdAt: number;
};

export type ReviewArtifactSummary = {
  id: string;
  taskId: string;
  snapshotId: string;
  queueItemId: string | null;
  scope: "queue" | "reviewer";
  summaryText: string;
  verdict: "passed" | "rejected" | "analysis";
  priorArtifactId: string | null;
  createdAt: number;
};

export type ReviewArtifact = ReviewArtifactSummary & {
  historyKey?: string | null;
  promptText?: string;
  responseText?: string;
};

export type ReviewArtifactResponse = {
  artifact: ReviewArtifactSummary | null;
};

export type ReviewArtifactListResponse = {
  items: ReviewArtifactSummary[];
};

export type TaskBundleTask = {
  externalId?: string;
  title?: string;
  prompt: string;
  agentId?: string | null;
  model?: string;
  priority?: number;
  inheritContext?: boolean;
  maxRetries?: number;
  attachments?: string[];
  execution?: {
    isolation?: TaskExecutionIsolation;
  };
};

export type TaskBundle = {
  version: 1;
  requestId?: string;
  runQueue?: boolean;
  autoApprove?: boolean;
  specRef?: string;
  insertPosition?: "front" | "back";
  defaults?: {
    execution?: {
      isolation?: TaskExecutionIsolation;
    };
  };
  tasks: TaskBundleTask[];
};

export type TaskBundleDraftSpecFileKey = "requirements" | "design" | "implementation";

export type TaskBundleDraftSpecFileMeta = {
  key: TaskBundleDraftSpecFileKey;
  fileName: string;
  missing: boolean;
};

export type TaskBundleDraftSpecSummary = {
  specRef: string;
  files: TaskBundleDraftSpecFileMeta[];
};

export type TaskBundleDraftSpecDocument = {
  specRef: string;
  key: TaskBundleDraftSpecFileKey;
  fileName: string;
  content: string;
  missing: boolean;
};

export type TaskBundleDraftSpecFileUpdate = {
  content: string;
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
  degradeReason?: string | null;
};
