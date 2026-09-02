export type TaskStatus =
  | "queued"
  | "pending"
  | "planning"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

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

export interface ReviewSettings {
  automationMode: ReviewAutomationMode;
  maxReworkRounds: number;
  updatedAt: number | null;
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

export type TaskRunStatus = "preparing" | "running" | "completed" | "failed" | "cancelled";
export type TaskRunCaptureStatus = "pending" | "ok" | "failed" | "skipped";
export type TaskRunApplyStatus = "pending" | "applied" | "blocked" | "failed" | "skipped";
export type TaskExecutionIsolation = "default" | "required";
export type TaskRunCleanupStatus = "pending" | "cleaned" | "failed" | "not_required";

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

export type TaskGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
  | "complete";

export interface Task {
  id: string;
  title: string;
  prompt: string;
  model: string;
  modelParams?: Record<string, unknown> | null;
  status: TaskStatus;
  priority: number;
  category?: TaskCategory;
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
  createdAt: number;
  startedAt?: number | null;
  completedAt?: number | null;
  archivedAt?: number | null;
  createdBy?: string | null;
  executionIsolation?: TaskExecutionIsolation;
  attachments?: Attachment[];
  latestRun?: TaskRun | null;
  goalMode?: boolean;
  goalObjective?: string | null;
  goalTokenBudget?: number | null;
  goalStatus?: TaskGoalStatus | null;
  goalTokensUsed?: number | null;
  goalTimeUsedSeconds?: number | null;
  review?: TaskReviewSummary;
  rootTaskId?: string;
  reviewChain?: Array<Pick<Task, "id" | "title" | "category" | "status"> & { review: TaskReviewSummary | null }>;
  reviewAudits?: Array<{ id: string; taskId: string; rootTaskId: string; action: string; reason: string | null; actorId: string; createdAt: number }>;
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

export interface CreateTaskInput {
  title?: string;
  prompt: string;
  agentId?: string | null;
  model?: string;
  priority?: number;
  category?: TaskCategory;
  executionIsolation?: TaskExecutionIsolation;
  maxRetries?: number;
  attachments?: string[];
  goalMode?: boolean;
  goalObjective?: string | null;
  goalTokenBudget?: number | null;
}

export interface ModelConfig {
  id: string;
  modelId?: string | null;
  displayName: string;
  provider: string;
  isEnabled: boolean;
  isDefault: boolean;
  configJson?: Record<string, unknown> | null;
}

export interface ReviewerModelSelection {
  modelConfigId: string | null;
  modelId: string | null;
  model: ModelConfig | null;
}

export type RuleSeverity = "advisory" | "required" | "approval_required" | "blocked";

export interface RuleMatch {
  agents?: string[];
  channels?: string[];
  tools?: string[];
  commandPatterns?: string[];
  pathPatterns?: string[];
}

export interface GlobalRule {
  id: string;
  title: string;
  body: string;
  category: string;
  severity: RuleSeverity;
  enabled: boolean;
  priority: number;
  createdAt: number;
  updatedAt: number;
  updatedBy: string | null;
  match: RuleMatch | null;
}

export interface GlobalRuleAuditEntry {
  id: number;
  ruleId: string;
  action: "create" | "update" | "enable" | "disable" | "delete";
  before: GlobalRule | null;
  after: GlobalRule | null;
  actor: string | null;
  ts: number;
}

export interface GlobalRulesPreview {
  text: string;
  hash: string;
  source: "database" | "bootstrap";
  degraded: boolean;
  ruleCount: number;
}

export interface RuleEnforcementResult {
  decision: "allow" | "require_approval" | "deny";
  effectiveDecision: "allow" | "require_approval" | "deny";
  mode: "observe" | "enforce";
  hits: Array<{
    ruleId: string;
    title: string;
    category: string;
    severity: RuleSeverity;
    matchedOn: string;
  }>;
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
  | { event: "command"; data: { taskId: string; command: string } }
  | { event: "review:updated"; data: { taskId: string; rootTaskId?: string | null; event: string; message: string; review: TaskReviewSummary } };

export type TaskBundleTask = {
  externalId?: string;
  title?: string;
  prompt: string;
  agentId?: string | null;
  model?: string;
  priority?: number;
  category?: TaskCategory;
  inheritContext?: boolean;
  maxRetries?: number;
  attachments?: string[];
};

export type TaskBundle = {
  version: 1;
  issueRef?: string;
  requestId?: string;
  runQueue?: boolean;
  autoApprove?: boolean;
  specRef?: string;
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
  degradeReason?: string | null;
};

export type SyncEvent = {
  seq: number;
  type: string;
  eventId?: string | null;
  revision: number;
  ts: number;
  runId?: string | null;
  payload: Record<string, unknown>;
};

export type SyncEventsResponse = {
  events: SyncEvent[];
  latestSeq: number;
  minAvailableSeq: number;
  hasMore: boolean;
  truncated: boolean;
  snapshot?: Record<string, unknown> | null;
};
